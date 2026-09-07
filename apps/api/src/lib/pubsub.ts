import type { Redis } from 'ioredis';
import { env } from '@forge/config';
import type { FastifyBaseLogger } from 'fastify';
import { closeRedis as closeConnection, createRedis } from '@forge/queue';

/**
 * The Redis Pub/Sub → local-sockets bridge (ARCHITECTURE §5).
 *
 * **One subscriber connection per API process**, not one per socket. A Redis
 * connection in subscriber mode can issue nothing but (un)subscribe, so it has
 * to be separate from the command connection — and multiplexing every socket
 * over it is the whole point: N browsers watching one deployment cost one
 * Redis subscription, and any API replica can serve any browser because the
 * events come from Redis rather than from the process that started the build.
 *
 * Channel subscriptions are **refcounted**: the first local listener for a
 * channel triggers SUBSCRIBE, the last one to leave triggers UNSUBSCRIBE, so
 * an idle process holds no subscriptions at all.
 */

export type PubSubHandler = (payload: string, channel: string) => void;

type ChannelState = {
  handlers: Set<PubSubHandler>;
  /** Whether Redis currently has our SUBSCRIBE for this channel. */
  subscribed: boolean;
  /** Serialises this channel's subscribe/unsubscribe calls against each other. */
  pending: Promise<void>;
};

/**
 * Fastify's own pino instance, injected at boot. Creating a second logger here
 * would spawn a second pino-pretty transport thread and lose the API's log
 * context, so the bridge borrows the app's.
 */
let log: FastifyBaseLogger;

export function configurePubSub(logger: FastifyBaseLogger): void {
  log = logger.child({ component: 'pubsub' });
}

let subscriber: Redis | null = null;
const channels = new Map<string, ChannelState>();

function getSubscriber(): Redis {
  if (subscriber) return subscriber;
  const client = createRedis(env.REDIS_URL, 'subscriber');

  client.on('message', (channel: string, payload: string) => {
    const state = channels.get(channel);
    if (!state) return;
    for (const handler of state.handlers) {
      try {
        handler(payload, channel);
      } catch (err) {
        // One bad socket must not stop the fan-out to the others.
        log.warn({ err, channel }, 'pubsub handler threw');
      }
    }
  });

  /**
   * ioredis re-subscribes automatically after a dropped connection, but only
   * to channels whose SUBSCRIBE previously succeeded — and an UNSUBSCRIBE that
   * failed mid-outage would leave us holding a channel nobody listens to (a
   * phantom subscription that survives every future reconnect). So on every
   * (re)connect, reconcile *every* channel in both directions and let the
   * handler sets decide what should actually be subscribed.
   */
  client.on('ready', () => {
    for (const [channel, state] of [...channels]) void reconcile(channel, state).catch(() => {});
  });

  subscriber = client;
  return client;
}

function reconcile(channel: string, state: ChannelState): Promise<void> {
  const task = async (): Promise<void> => {
    // Read intent at execution time, not enqueue time: a subscribe that raced
    // with an unsubscribe collapses to a no-op instead of thrashing Redis.
    const wanted = state.handlers.size > 0;
    if (wanted === state.subscribed) {
      if (!wanted) channels.delete(channel);
      return;
    }
    if (wanted) {
      await getSubscriber().subscribe(channel);
      state.subscribed = true;
      log.debug({ channel }, 'subscribed');
      return;
    }
    await getSubscriber().unsubscribe(channel);
    state.subscribed = false;
    channels.delete(channel);
    log.debug({ channel }, 'unsubscribed');
  };

  // `.catch` before `.then`: a task chained onto a *rejected* predecessor would
  // otherwise be skipped entirely, so one failed SUBSCRIBE (Redis down) would
  // poison the channel and every later attempt on it would silently no-op.
  state.pending = state.pending.catch(() => undefined).then(task);
  return state.pending;
}

/**
 * Adds a listener for a channel, subscribing to Redis if this is the first one.
 *
 * Resolves once the subscription is actually in place, so a caller can promise
 * its client "you are subscribed" truthfully — and rejects if Redis refused,
 * rather than silently delivering nothing.
 */
export async function subscribeChannel(
  channel: string,
  handler: PubSubHandler,
): Promise<() => void> {
  let state = channels.get(channel);
  if (!state) {
    state = { handlers: new Set(), subscribed: false, pending: Promise.resolve() };
    channels.set(channel, state);
  }
  state.handlers.add(handler);

  const current = state;
  try {
    await reconcile(channel, current);
  } catch (err) {
    // Roll the listener back so a failed subscribe leaves no state behind and
    // the next attempt on this channel starts clean.
    current.handlers.delete(handler);
    await reconcile(channel, current).catch(() => undefined);
    throw err;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    current.handlers.delete(handler);
    void reconcile(channel, current).catch((err: unknown) => {
      log.warn({ err, channel }, 'failed to unsubscribe');
    });
  };
}

/** Channels this process currently holds — for logging and the WS stats view. */
export function pubsubStats(): { channels: number; listeners: number; connected: boolean } {
  let listeners = 0;
  for (const state of channels.values()) listeners += state.handlers.size;
  return {
    channels: channels.size,
    listeners,
    connected: subscriber?.status === 'ready',
  };
}

export async function closePubSub(): Promise<void> {
  const client = subscriber;
  subscriber = null;
  channels.clear();
  await closeConnection(client);
}
