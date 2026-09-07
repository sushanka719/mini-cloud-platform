import { QUEUE_NAMES, REDIS_KEYS, type Fleet, type QueueStats, type WorkerView } from '@forge/shared';
import { workerRepo } from '@forge/db';
import { getQueueStats } from '@forge/queue';
import { getRedis } from '../lib/redis.js';
import { toWorkerView } from './serializers.js';

/**
 * The fleet view: what the queue holds and which workers are alive.
 *
 * Liveness is Redis, not the registry row. A worker killed with SIGKILL never
 * writes `offline`, so the row lies; the heartbeat key's TTL doesn't. The two
 * are combined in `toWorkerView`.
 */

/**
 * Reads the heartbeat keys. If Redis is unreachable this returns an empty set
 * rather than throwing: with no liveness signal every worker is reported
 * `offline`, which is the honest answer and keeps the page rendering from
 * Postgres instead of 500-ing the whole view (CLAUDE.md §10).
 */
async function readOnline(workerIds: string[]): Promise<Set<string>> {
  const online = new Set<string>();
  if (workerIds.length === 0) return online;
  let results: [Error | null, unknown][] | null;
  try {
    const pipeline = getRedis().pipeline();
    for (const id of workerIds) pipeline.exists(REDIS_KEYS.workerHeartbeat(id));
    results = await pipeline.exec();
  } catch {
    return online;
  }
  results?.forEach(([err, value], index) => {
    const id = workerIds[index];
    if (!err && value === 1 && id) online.add(id);
  });
  return online;
}

export async function getWorkers(): Promise<WorkerView[]> {
  const rows = await workerRepo.listWorkers();
  const online = await readOnline(rows.map((row) => row.id));
  return rows.map((row) => toWorkerView(row, online.has(row.id)));
}

/**
 * Queue counts come from BullMQ (i.e. Redis). If Redis is down the workers list
 * still renders from Postgres and the queue block reports `available: false`
 * rather than failing the whole page — degrade, don't crash (CLAUDE.md §10).
 * `paused` stays false: a queue nobody can read is not a paused queue.
 */
async function safeQueueStats(): Promise<QueueStats> {
  try {
    return await getQueueStats();
  } catch {
    return {
      name: QUEUE_NAMES.deployments,
      available: false,
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: false,
    };
  }
}

export async function getFleet(): Promise<Fleet> {
  const [queue, workers] = await Promise.all([safeQueueStats(), getWorkers()]);
  return { queue, workers };
}
