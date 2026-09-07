import { Queue, Worker, type Job, type Processor } from 'bullmq';
import {
  CONTAINER_ACTION_JOB_NAME,
  QUEUE_NAMES,
  containerActionJobSchema,
  type ContainerActionJob,
  type QueueStats,
} from '@forge/shared';
import type { Redis } from 'ioredis';
import { closeRedis, createRedis } from './connection.js';
import { requireConfig, trackBorrowed, withDeadline } from './runtime.js';

/**
 * The `container-actions` queue: stop and restart requests for a running
 * container (Phase 7).
 *
 * It exists because the API is not allowed to talk to Docker (ARCHITECTURE §9:
 * "the API never imports Docker or `child_process` logic"), so a stop has to
 * travel the same way a deploy does — recorded as intent, executed by a worker,
 * published back over Redis.
 *
 * A *separate* queue rather than another job name on `deployments`, for two
 * reasons. Operationally, a stop must not sit behind a five-minute build in a
 * concurrency-2 worker. And structurally, the `deployments` queue's semantics —
 * job id = deployment id, one attempt, idempotent per deployment — are exactly
 * wrong here: two stops of the same deployment are two legitimate requests, and
 * reusing the deployment id as the job id would make the second one vanish.
 * Those semantics are also what CLAUDE.md §13 says not to change, so they are
 * left alone.
 */

let queue: Queue<ContainerActionJob> | null = null;
let queueConnection: Redis | null = null;

export function getContainerActionsQueue(): Queue<ContainerActionJob> {
  if (queue) return queue;
  const cfg = requireConfig();
  queueConnection = createRedis(cfg.redisUrl, 'bullmq');
  queue = new Queue<ContainerActionJob>(QUEUE_NAMES.containerActions, {
    connection: queueConnection,
    defaultJobOptions: {
      // One attempt, deliberately. A stop that failed because Docker is down
      // should surface as a failure the user can retry by clicking again, not
      // fire three times against a daemon that may have come back in between.
      attempts: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  });
  return queue;
}

/**
 * Enqueues one action.
 *
 * No `jobId`: BullMQ assigns one. Two stop requests for the same deployment are
 * two requests — the second is a no-op at the Docker level (the container is
 * already gone) and saying so is more honest than silently dropping it.
 */
export async function enqueueContainerAction(
  job: ContainerActionJob,
): Promise<Job<ContainerActionJob>> {
  const payload = containerActionJobSchema.parse(job);
  return withDeadline(
    'addContainerAction',
    getContainerActionsQueue().add(CONTAINER_ACTION_JOB_NAME, payload),
  );
}

export async function getContainerActionQueueStats(): Promise<QueueStats> {
  const q = getContainerActionsQueue();
  const counts = await withDeadline(
    'getContainerActionCounts',
    q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
  );
  return {
    name: QUEUE_NAMES.containerActions,
    available: true,
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
    paused: await withDeadline('containerActionsPaused', q.isPaused()),
  };
}

export type ContainerActionWorkerOptions = {
  concurrency: number;
  processor: Processor<ContainerActionJob, void, string>;
};

/**
 * The consumer side. Its own BullMQ worker, so its concurrency is independent
 * of `WORKER_CONCURRENCY` — a worker fully occupied with two builds can still
 * stop a container.
 */
export function createContainerActionWorker(
  options: ContainerActionWorkerOptions,
): Worker<ContainerActionJob> {
  const cfg = requireConfig();
  const connection = trackBorrowed(createRedis(cfg.redisUrl, 'bullmq'));
  return new Worker<ContainerActionJob, void, string>(
    QUEUE_NAMES.containerActions,
    options.processor,
    {
      connection,
      concurrency: options.concurrency,
      autorun: false,
    },
  );
}

export async function closeContainerActionsQueue(): Promise<void> {
  const current = queue;
  const connection = queueConnection;
  queue = null;
  queueConnection = null;
  if (current) await current.close();
  await closeRedis(connection);
}
