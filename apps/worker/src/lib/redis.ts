import type { Redis } from 'ioredis';
import { env } from '@forge/config';
import { closeRedis as closeConnection, connectRedis, createRedis } from '@forge/queue';

/**
 * The worker's own command connection — used for heartbeats and for publishing
 * pipeline events. BullMQ keeps its own connections (different retry rules),
 * created inside `@forge/queue`.
 */
let client: Redis | null = null;
let publisherClient: Redis | null = null;

export function getRedis(): Redis {
  if (client) return client;
  client = createRedis(env.REDIS_URL, 'command');
  return client;
}

/**
 * Publishing pipeline events is best-effort (Postgres already has the durable
 * record), so it gets its own connection with ioredis's offline queue
 * disabled: while Redis is down a publish fails instantly instead of parking
 * the whole pipeline behind a reconnect.
 */
export function getPublisher(): Redis {
  if (publisherClient) return publisherClient;
  publisherClient = createRedis(env.REDIS_URL, 'command', { enableOfflineQueue: false });
  return publisherClient;
}

export async function openRedis(): Promise<void> {
  await connectRedis(getRedis());
}

export async function closeRedis(): Promise<void> {
  const current = client;
  const publisher = publisherClient;
  client = null;
  publisherClient = null;
  await Promise.allSettled([closeConnection(current), closeConnection(publisher)]);
}
