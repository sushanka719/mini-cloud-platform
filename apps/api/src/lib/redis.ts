import type { Redis } from 'ioredis';
import { env } from '@forge/config';
import { closeRedis as closeConnection, connectRedis as openConnection, createRedis } from '@forge/queue';

/**
 * Command connection for the API process.
 *
 * The connection *factory* now lives in `@forge/queue` (as Phase 0 noted it
 * would) so the API, the worker and BullMQ share one set of retry/timeout
 * rules. This module is just the process-wide handle plus the injection of
 * `REDIS_URL`, which `@forge/queue` is not allowed to read itself
 * (ARCHITECTURE §9).
 *
 * Pub/Sub needs its own connection — a subscriber can't run normal commands —
 * and arrives with the WS gateway in Phase 5.
 */
let client: Redis | null = null;
let rateLimitClient: Redis | null = null;
let publisherClient: Redis | null = null;

export function getRedis(): Redis {
  if (client) return client;
  client = createRedis(env.REDIS_URL, 'command');
  return client;
}

/**
 * Fire-and-forget PUBLISH connection, also with the offline queue disabled.
 *
 * Publishing a pipeline event is best-effort — the durable record is already
 * in Postgres and Phase 5's reconnect replay reads it back — so a publish must
 * never add seconds to a request while Redis is reconnecting.
 */
export function getPublisherRedis(): Redis {
  if (publisherClient) return publisherClient;
  publisherClient = createRedis(env.REDIS_URL, 'command', { enableOfflineQueue: false });
  return publisherClient;
}

/**
 * A separate connection for the rate limiter, with the offline queue disabled.
 *
 * On the shared command connection, a command issued while Redis is
 * reconnecting waits in ioredis's offline queue until the retry cap is hit —
 * several seconds. The limiter runs on *every* request and fails open, so
 * waiting is pointless: with `enableOfflineQueue: false` its INCR fails
 * immediately, `skipOnError` serves the request, and a dead Redis costs
 * latency instead of adding it (CLAUDE.md §10).
 */
export function getRateLimitRedis(): Redis {
  if (rateLimitClient) return rateLimitClient;
  rateLimitClient = createRedis(env.REDIS_URL, 'command', { enableOfflineQueue: false });
  return rateLimitClient;
}

/** Opens the connection (idempotent). Awaited at startup so boot fails loudly. */
export async function connectRedis(): Promise<void> {
  await openConnection(getRedis());
}

export async function pingRedis(): Promise<void> {
  await connectRedis();
  const pong = await getRedis().ping();
  if (pong !== 'PONG') throw new Error(`unexpected redis ping response: ${pong}`);
}

export async function closeRedis(): Promise<void> {
  const current = client;
  const limiter = rateLimitClient;
  const publisher = publisherClient;
  client = null;
  rateLimitClient = null;
  publisherClient = null;
  await Promise.allSettled([
    closeConnection(current),
    closeConnection(limiter),
    closeConnection(publisher),
  ]);
}
