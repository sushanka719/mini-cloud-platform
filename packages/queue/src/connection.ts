import { Redis, type RedisOptions } from 'ioredis';

/**
 * Every Redis connection in ForgeCloud is created here, so the API, the worker
 * and BullMQ can't drift apart on retry/timeout behaviour.
 *
 * The package takes the URL as an argument rather than reading the environment:
 * ARCHITECTURE §9 allows `queue → shared` only, so config is injected by the
 * app that boots it (same rule `@forge/storage` follows for STORAGE_ROOT).
 */

export type RedisRole =
  /** Normal commands: GET/SET/PUBLISH. Fails fast when Redis is down. */
  | 'command'
  /** BullMQ's own connections — they block with BRPOPLPUSH and must not retry-cap. */
  | 'bullmq'
  /** A subscriber; once subscribed it can issue nothing but (un)subscribe. */
  | 'subscriber';

function optionsFor(role: RedisRole): RedisOptions {
  const base: RedisOptions = {
    // Deliberately NOT lazyConnect. With a lazy client, a *first* connection
    // that fails leaves the client in `end` and it never retries — so a
    // process started while Redis was down stays permanently broken even
    // after Redis comes back. Connecting eagerly puts every failure, first or
    // later, through `retryStrategy`, which reconnects forever.
    connectTimeout: 5_000,
    retryStrategy: (times) => Math.min(times * 200, 3_000),
  };
  if (role === 'bullmq') {
    // BullMQ requirement: blocking commands must never be aborted by the retry
    // cap, or a worker silently stops consuming. It also does its own readiness
    // handling, so the ready check is redundant.
    return { ...base, maxRetriesPerRequest: null, enableReadyCheck: false };
  }
  // Commands issued while the connection is down are queued and then rejected,
  // so a dead Redis fails a request in seconds instead of hanging it.
  return { ...base, maxRetriesPerRequest: 2 };
}

export function createRedis(url: string, role: RedisRole = 'command', extra: RedisOptions = {}): Redis {
  const client = new Redis(url, { ...optionsFor(role), ...extra });
  // An unhandled 'error' on an ioredis client is a process-killing throw.
  client.on('error', (err: Error) => {
    process.emitWarning(`redis ${role} error: ${err.message}`);
  });
  return client;
}

/**
 * Waits until the client is usable. Idempotent, and safe to call on a client
 * that is already connecting — which is the normal case now that connections
 * are eager. A client that has been explicitly ended is re-opened.
 */
export async function connectRedis(client: Redis): Promise<void> {
  if (client.status === 'ready') return;
  if (client.status === 'wait' || client.status === 'end') {
    await client.connect();
    return;
  }
  // Already connecting/reconnecting — wait for it to settle either way.
  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      client.off('error', onError);
      resolve();
    };
    const onError = (err: Error) => {
      client.off('ready', onReady);
      reject(err);
    };
    client.once('ready', onReady);
    client.once('error', onError);
  });
}

/** Closes cleanly, falling back to dropping the socket if QUIT can't be sent. */
export async function closeRedis(client: Redis | null): Promise<void> {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
