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
import { defaultJobOptions, requireConfig, trackBorrowed, withDeadline } from './runtime.js';

/**
 * The `deployments` queue: the one seam between the API (producer) and the
 * worker (consumer). Both import this module, so the queue name, the job name
 * and the payload shape are defined exactly once (CLAUDE.md §11).
 */

let queue: Queue<DeploymentJob> | null = null;
let queueConnection: Redis | null = null;

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

/**
 * Where a deployment's job currently sits in BullMQ, or null if the queue has
 * no record of it at all.
 *
 * Read by Phase 10's orphan sweep, and the reason it exists is to keep the
 * sweep out of BullMQ's way: a job still `active`, `waiting` or `delayed` is
 * one the queue is going to re-deliver on its own, and failing its deployment
 * from the outside would race that recovery. Only a deployment whose job is
 * genuinely gone (or already `failed`) is the sweep's business.
 */
export async function getDeploymentJobState(deploymentId: string): Promise<string | null> {
  const job = await withDeadline('getJob', getDeploymentsQueue().getJob(deploymentId));
  if (!job) return null;
  return withDeadline('getState', job.getState());
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
  /** How long a job's lock lives without renewal before it counts as stalled. */
  lockDurationMs?: number;
  /**
   * How often this worker scans for jobs whose lock has lapsed (Phase 10).
   *
   * Every worker runs the scan, and BullMQ's own Redis lock makes sure only one
   * of them acts on a given tick — which is the point: the process that
   * recovers a crashed worker's job must not be the crashed worker.
   */
  stalledIntervalMs?: number;
  /**
   * How many times one job may be recovered from a stall before BullMQ fails
   * it outright. A stall does not consume a retry attempt, so without a
   * ceiling a job that reliably kills its worker would work through the whole
   * fleet, one process at a time.
   */
  maxStalledCount?: number;
};

/**
 * The consumer side. Each worker process creates exactly one of these; the
 * queue guarantees a job is delivered to exactly one worker, which is what
 * makes "run N workers" a real scaling demo (ARCHITECTURE §7).
 */
export function createDeploymentWorker(options: DeploymentWorkerOptions): Worker<DeploymentJob> {
  const cfg = requireConfig();
  const connection = createRedis(cfg.redisUrl, 'bullmq');
  trackBorrowed(connection);
  return new Worker<DeploymentJob, void, string>(QUEUE_NAMES.deployments, options.processor, {
    connection,
    concurrency: options.concurrency,
    lockDuration: options.lockDurationMs ?? 30_000,
    stalledInterval: options.stalledIntervalMs ?? 15_000,
    maxStalledCount: options.maxStalledCount ?? 2,
    // Never auto-run jobs before the process has finished registering itself.
    autorun: false,
  });
}

/** Queue-level event stream (completed/failed/stalled), for observability. */
export function createDeploymentQueueEvents(): QueueEvents {
  const cfg = requireConfig();
  const connection = createRedis(cfg.redisUrl, 'bullmq');
  trackBorrowed(connection);
  return new QueueEvents(QUEUE_NAMES.deployments, { connection });
}

export async function closeDeploymentsQueue(): Promise<void> {
  const current = queue;
  const connection = queueConnection;
  queue = null;
  queueConnection = null;
  if (current) await current.close();
  await closeRedis(connection);
}
