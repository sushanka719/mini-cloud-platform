import { Queue, QueueEvents, Worker, type Job, type JobsOptions, type Processor } from 'bullmq';
import {
  DEPLOYMENT_JOB_NAME,
  QUEUE_NAMES,
  deploymentJobSchema,
  type DeploymentJob,
  type QueueStats,
} from '@forge/shared';
import type { Redis } from 'ioredis';
import { closeRedis, createRedis } from './connection.js';

/**
 * The `deployments` queue: the one seam between the API (producer) and the
 * worker (consumer). Both import this module, so the queue name, the job name
 * and the payload shape are defined exactly once (CLAUDE.md §11).
 */

export type QueueConfig = {
  redisUrl: string;
  /**
   * Deadline for a single producer-side queue operation. BullMQ's connections
   * must use `maxRetriesPerRequest: null` (blocking commands would otherwise be
   * aborted), which means a command issued while Redis is down waits forever.
   * A producer must not: an HTTP request has to fail visibly instead of
   * hanging (CLAUDE.md §10).
   */
  operationTimeoutMs?: number;
  /** BullMQ attempts per job. Phase 8 raises this and adds the dead-letter hop. */
  attempts?: number;
  /** Base delay for exponential backoff between attempts, in ms. */
  backoffMs?: number;
  /** How many completed/failed jobs BullMQ keeps for inspection. */
  keepCompleted?: number;
  keepFailed?: number;
};

let config: QueueConfig | null = null;
let queue: Queue<DeploymentJob> | null = null;
let queueConnection: Redis | null = null;
/**
 * Connections handed to BullMQ Workers/QueueEvents. BullMQ does not close a
 * connection it did not create, so we keep them here and close them in
 * `closeQueue()` — otherwise a worker's graceful shutdown leaks a socket.
 */
const borrowedConnections = new Set<Redis>();

export function configureQueue(next: QueueConfig): void {
  config = next;
}

function requireConfig(): QueueConfig {
  if (!config) {
    throw new Error('@forge/queue is not configured — call configureQueue({ redisUrl }) at boot');
  }
  return config;
}

class QueueTimeoutError extends Error {
  constructor(operation: string, ms: number) {
    super(`Queue operation "${operation}" did not complete within ${ms}ms`);
    this.name = 'QueueTimeoutError';
  }
}

/** Bounds one queue command; see `operationTimeoutMs` above. */
async function withDeadline<T>(operation: string, work: Promise<T>): Promise<T> {
  const ms = config?.operationTimeoutMs ?? 5_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new QueueTimeoutError(operation, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function defaultJobOptions(cfg: QueueConfig): JobsOptions {
  return {
    attempts: cfg.attempts ?? 1,
    backoff: { type: 'exponential', delay: cfg.backoffMs ?? 5_000 },
    // Keep a bounded history so the dashboard/queue stats stay meaningful
    // without Redis growing forever.
    removeOnComplete: { count: cfg.keepCompleted ?? 200 },
    removeOnFail: { count: cfg.keepFailed ?? 500 },
  };
}

/** Process-wide producer handle. Created lazily; the API opens it at boot. */
export function getDeploymentsQueue(): Queue<DeploymentJob> {
  if (queue) return queue;
  const cfg = requireConfig();
  queueConnection = createRedis(cfg.redisUrl, 'bullmq');
  queue = new Queue<DeploymentJob>(QUEUE_NAMES.deployments, {
    connection: queueConnection,
    defaultJobOptions: defaultJobOptions(cfg),
  });
  return queue;
}

/**
 * Enqueues a deployment. The BullMQ job id is the deployment id, so an
 * accidental re-enqueue of the same deployment is a no-op at the queue level
 * too — belt and braces alongside the DB idempotency constraint.
 */
export async function enqueueDeployment(
  job: DeploymentJob,
  options: JobsOptions = {},
): Promise<Job<DeploymentJob>> {
  // Validate on the way in: a malformed payload should fail at the producer,
  // not inside a worker three seconds later.
  const payload = deploymentJobSchema.parse(job);
  return withDeadline(
    'add',
    getDeploymentsQueue().add(DEPLOYMENT_JOB_NAME, payload, {
      jobId: payload.deploymentId,
      ...options,
    }),
  );
}

/** Removes a finished job's record so its id can be reused by a retry. */
export async function forgetDeploymentJob(deploymentId: string): Promise<void> {
  const existing = await withDeadline('getJob', getDeploymentsQueue().getJob(deploymentId));
  if (existing) await withDeadline('remove', existing.remove());
}

export async function getQueueStats(): Promise<QueueStats> {
  const q = getDeploymentsQueue();
  const counts = await withDeadline(
    'getJobCounts',
    q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
  );
  return {
    name: QUEUE_NAMES.deployments,
    available: true,
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
    paused: await withDeadline('isPaused', q.isPaused()),
  };
}

export type DeploymentWorkerOptions = {
  concurrency: number;
  processor: Processor<DeploymentJob, void, string>;
  /** Seconds before an unreported job is considered stalled and re-queued. */
  lockDurationMs?: number;
};

/**
 * The consumer side. Each worker process creates exactly one of these; the
 * queue guarantees a job is delivered to exactly one worker, which is what
 * makes "run N workers" a real scaling demo (ARCHITECTURE §7).
 */
export function createDeploymentWorker(options: DeploymentWorkerOptions): Worker<DeploymentJob> {
  const cfg = requireConfig();
  const connection = createRedis(cfg.redisUrl, 'bullmq');
  borrowedConnections.add(connection);
  return new Worker<DeploymentJob, void, string>(QUEUE_NAMES.deployments, options.processor, {
    connection,
    concurrency: options.concurrency,
    lockDuration: options.lockDurationMs ?? 60_000,
    // Never auto-run jobs before the process has finished registering itself.
    autorun: false,
  });
}

/** Queue-level event stream (completed/failed/stalled), for observability. */
export function createDeploymentQueueEvents(): QueueEvents {
  const cfg = requireConfig();
  const connection = createRedis(cfg.redisUrl, 'bullmq');
  borrowedConnections.add(connection);
  return new QueueEvents(QUEUE_NAMES.deployments, { connection });
}

export { QueueTimeoutError };

export async function closeQueue(): Promise<void> {
  const current = queue;
  const connection = queueConnection;
  const borrowed = [...borrowedConnections];
  queue = null;
  queueConnection = null;
  borrowedConnections.clear();
  if (current) await current.close();
  await Promise.allSettled([
    closeRedis(connection),
    ...borrowed.map((client) => closeRedis(client)),
  ]);
}
