import {
  QUEUE_NAMES,
  REDIS_KEYS,
  type ApiReplicaView,
  type Fleet,
  type QueueStats,
  type WorkerView,
} from '@forge/shared';
import { env } from '@forge/config';
import { workerRepo } from '@forge/db';
import { getContainerActionQueueStats, getDeadLetterStats, getQueueStats } from '@forge/queue';
import { getRedis } from '../lib/redis.js';
import { readFleetMetrics } from '../observability/metrics-store.js';
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
  const rows = await workerRepo.listWorkers({
    seenWithinMs: env.FLEET_WORKER_WINDOW_MINUTES * 60_000,
  });
  const online = await readOnline(rows.map((row) => row.id));
  return rows.map((row) => toWorkerView(row, online.has(row.id)));
}

/**
 * Queue counts come from BullMQ (i.e. Redis). If Redis is down the workers list
 * still renders from Postgres and the queue block reports `available: false`
 * rather than failing the whole page — degrade, don't crash (CLAUDE.md §10).
 * `paused` stays false: a queue nobody can read is not a paused queue.
 */
async function safeQueueStats(
  name: string,
  read: () => Promise<QueueStats>,
): Promise<QueueStats> {
  try {
    return await read();
  } catch {
    return {
      name,
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

/**
 * All three queues, read independently.
 *
 * `deployments-dlq` is in here because a fleet view that shows the retry budget
 * being spent but not where the exhausted jobs land tells half the story — the
 * dead-letter depth is the one number that says "something needs a human".
 * Each is wrapped separately so one unreadable queue does not blank the others.
 *
 * Shared with the Phase 9 metrics snapshot and the `metrics` topic publisher,
 * so the fleet page, the dashboard's queue chart and the Prometheus scrape are
 * three views of one read rather than three subtly different ones. The order
 * is fixed — deployments, dead-letter, container-actions — because callers
 * that want them by name destructure it.
 */
export async function readQueueStats(): Promise<[QueueStats, QueueStats, QueueStats]> {
  return Promise.all([
    safeQueueStats(QUEUE_NAMES.deployments, getQueueStats),
    safeQueueStats(QUEUE_NAMES.deploymentsDlq, getDeadLetterStats),
    safeQueueStats(QUEUE_NAMES.containerActions, getContainerActionQueueStats),
  ]);
}

/**
 * The API replicas, projected out of Phase 9's process-metrics documents.
 *
 * There is no `api_instances` table and there should not be: an API replica
 * holds nothing authoritative, so the only interesting fact about one is that
 * it is currently running — and a Redis document under a TTL already says
 * exactly that, written by the process itself. A replica that is SIGKILLed
 * drops out of this list when its key expires, the same rule workers follow.
 *
 * Which means a replica appears here **only while `METRICS_INTERVAL_MS` is
 * non-zero**. That is a real coupling and worth stating rather than papering
 * over with a second heartbeat that could disagree with the first: with the
 * reporter switched off there is no liveness signal for an API process at all,
 * and an empty list is the honest rendering of that.
 *
 * Returns `[]` rather than throwing if Redis is unreadable — the workers half
 * of the page still renders from Postgres (CLAUDE.md §10).
 */
export async function getApiReplicas(): Promise<ApiReplicaView[]> {
  let processes;
  try {
    processes = await readFleetMetrics();
  } catch {
    return [];
  }
  return processes
    .filter((process) => process.role === 'api')
    .map((process) => ({
      instance: process.instance,
      host: process.host,
      pid: process.pid,
      uptimeMs: process.uptimeMs,
      cpuPercent: process.cpuPercent,
      rssBytes: process.rssBytes,
      sockets: process.api?.sockets ?? 0,
      requestsPerSecond: process.api?.requestsPerSecond ?? 0,
      inflight: process.api?.inflight ?? 0,
      at: process.at,
    }));
}

export async function getFleet(): Promise<Fleet> {
  const [[queue, deadLetter, containerActions], workers, api] = await Promise.all([
    readQueueStats(),
    getWorkers(),
    getApiReplicas(),
  ]);
  return { queue, deadLetter, containerActions, workers, api };
}
