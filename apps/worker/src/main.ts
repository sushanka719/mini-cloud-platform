import { createLogger, env } from '@forge/config';
import { closeDb, pingDb, workerRepo } from '@forge/db';
import {
  closeQueue,
  configureQueue,
  createContainerActionWorker,
  createDeploymentWorker,
} from '@forge/queue';
import { closeCompressionPool } from '@forge/storage';
import { MetricsReporter } from '@forge/metrics';
import { closeRedis, openRedis } from './lib/redis.js';
import { WorkerRegistry } from './services/worker-registry.js';
import { createProcessor } from './processor.js';
import { createContainerActionProcessor } from './container-processor.js';
import { ContainerMonitor } from './services/container-monitor.js';
import { OrphanReaper } from './services/orphan-reaper.js';
import { createWorkerMetricsSink, forgetProcessMetrics } from './observability/metrics-sink.js';
import { abortAllBuilds, activeBuildCount } from './build/active-builds.js';
import { pruneStaleSandboxes } from './build/sandbox.js';
import { reportDockerAvailability } from './docker/client.js';
import { sweepOrphanContainers } from './docker/sweep.js';

/**
 * A ForgeCloud worker process.
 *
 * It serves no HTTP: it registers itself, consumes the `deployments` queue and
 * runs the pipeline. Run several of these against the same Redis and BullMQ
 * hands each job to exactly one of them — that is the whole local-scaling
 * story (ARCHITECTURE §7).
 */
const log = createLogger('worker', { base: { service: 'worker', pid: process.pid } });

/**
 * A sandbox older than this belonged to a process that is gone. Comfortably
 * longer than the longest step either timeout allows, so a slow build in
 * progress is never swept out from under itself.
 */
const STALE_SANDBOX_MS =
  Math.max(env.BUILD_INSTALL_TIMEOUT_MS, env.BUILD_BUILD_TIMEOUT_MS) * 2 + 60 * 60 * 1000;

configureQueue({
  redisUrl: env.REDIS_URL,
  attempts: env.DEPLOY_JOB_ATTEMPTS,
  backoffMs: env.DEPLOY_JOB_BACKOFF_MS,
  operationTimeoutMs: env.QUEUE_OPERATION_TIMEOUT_MS,
  deadLetterKeep: env.DEPLOY_DLQ_KEEP,
});

const registry = new WorkerRegistry(log);

// Fail loudly at boot rather than on the first job.
await pingDb();
await openRedis();

// Housekeeping: forget worker rows from processes that died long ago and never
// ran anything, so the fleet view stays readable across restarts.
const pruned = await workerRepo.pruneStaleWorkers(env.WORKER_HEARTBEAT_MS * 240);
if (pruned > 0) log.info({ pruned }, 'pruned stale worker registrations');

// Same idea for the build sandboxes: a SIGKILL'd worker never runs its
// cleanup, so directories from a previous life are swept here. Age-based,
// because another live worker may own a sandbox right now.
const sandboxes = await pruneStaleSandboxes(env.BUILD_ROOT, STALE_SANDBOX_MS);
if (sandboxes.removed > 0) {
  log.info(sandboxes, 'pruned stale build sandboxes');
}

// Docker is checked but not required: a worker without it can still clone,
// install and build, and failing at `creating_container` with a stated reason
// beats refusing to start.
const dockerReady = await reportDockerAvailability(log);

// The container equivalent of the sandbox sweep. A SIGKILLed worker leaves a
// container running — holding a port, serving an app the database calls
// `failed` — so containers no live deployment claims are removed here. Safe
// with other workers running, because the claim is a Postgres row, not an age.
if (dockerReady) {
  try {
    const orphans = await sweepOrphanContainers(log);
    if (orphans.removed > 0 || orphans.inspected > 0) {
      log.info(orphans, 'swept deployment containers');
    }
  } catch (err) {
    log.warn({ err }, 'container sweep failed; continuing');
  }
}

const workerId = await registry.register();

/** Set by `shutdown()`; read by the consumer-loop handler below. */
let shuttingDown = false;

const queueWorker = createDeploymentWorker({
  concurrency: env.WORKER_CONCURRENCY,
  lockDurationMs: env.DEPLOY_JOB_LOCK_MS,
  // The three knobs behind Phase 10's crash recovery: how long a dead worker's
  // job stays locked, how often the survivors look for one, and how many times
  // a single job may be rescued before BullMQ decides the job itself is what
  // keeps killing workers.
  stalledIntervalMs: env.DEPLOY_JOB_STALL_INTERVAL_MS,
  maxStalledCount: env.DEPLOY_JOB_MAX_STALLED,
  processor: createProcessor(registry, log),
});

queueWorker.on('failed', (job, err) => {
  log.warn({ jobId: job?.id, attempt: job?.attemptsMade, err }, 'job failed');
});
queueWorker.on('completed', (job) => {
  log.debug({ jobId: job.id }, 'job completed');
});
queueWorker.on('stalled', (jobId) => {
  // The previous owner stopped renewing its lock, and *this* process is the one
  // that noticed. The job is back in the queue; whoever picks it up next runs
  // `takeOverAbandoned()` and hands the row to itself. This is the Phase 10
  // demo, logged from the survivor's point of view.
  log.warn({ jobId }, 'job stalled and was returned to the queue');
});
queueWorker.on('error', (err) => {
  log.error({ err }, 'queue worker error');
});

// `autorun: false` above: nothing is consumed until the registry row exists.
// run() only settles when the worker stops, so a rejection here means the
// consumer loop died — shut down rather than sitting idle pretending to work.
queueWorker.run().catch((err: unknown) => {
  if (shuttingDown) return;
  log.fatal({ err }, 'queue consumer loop stopped unexpectedly');
  void shutdown('consumerLoopFailed', 1);
});

/**
 * The container-action consumer: stop/restart, which the API cannot do itself.
 *
 * Its own BullMQ worker with its own concurrency, so a worker fully occupied
 * with two builds can still stop a container — the whole reason these are not
 * jobs on the `deployments` queue.
 */
const actionWorker = createContainerActionWorker({
  concurrency: 2,
  processor: createContainerActionProcessor(log),
});

actionWorker.on('failed', (job, err) => {
  log.warn({ jobId: job?.id, action: job?.data.action, err }, 'container action failed');
});
actionWorker.on('error', (err) => {
  log.error({ err }, 'container action worker error');
});

actionWorker.run().catch((err: unknown) => {
  if (shuttingDown) return;
  log.error({ err }, 'container action consumer loop stopped unexpectedly');
});

// Samples CPU/memory for every running container into Redis, where the API
// reads them, and publishes each sample on the deployment's/project's/org's
// channels. Leader-elected per tick, so N workers do not each poll Docker for
// every container.
const monitor = new ContainerMonitor(log);
monitor.start();

/**
 * The backstop for a deployment whose worker died *and* whose job the queue no
 * longer has (Phase 10). BullMQ's stall recovery handles the normal case; this
 * only stops a row nothing owns from spinning on the dashboard forever.
 *
 * Run once at boot as well as on the timer: a laptop where every worker was
 * stopped at once is exactly the situation that leaves such rows behind, and
 * the first worker back deserves to clean up after them.
 */
const reaper = new OrphanReaper(log);
try {
  const swept = await reaper.sweep();
  if (swept.reaped > 0) log.warn(swept, 'reaped abandoned deployments at boot');
} catch (err) {
  log.warn({ err }, 'boot-time orphan sweep failed; continuing');
}
reaper.start();

/**
 * This process's own metrics (Phase 9).
 *
 * A worker serves no HTTP, so it cannot be scraped: its numbers reach the
 * dashboard only by being written to Redis, where the API's `/metrics` and the
 * metrics page read them. Event-loop lag matters most here of all three
 * process kinds — this is the process that spawns `npm install` and streams
 * its output, so it is where a blocked loop actually shows up.
 */
const metrics = new MetricsReporter({
  role: 'worker',
  instance: registry.name,
  intervalMs: env.METRICS_INTERVAL_MS,
  sink: createWorkerMetricsSink(),
  log,
  extras: () => ({
    worker: {
      workerId: registry.registeredId,
      status: registry.currentStatus,
      activeJobs: registry.activeCount,
      concurrency: env.WORKER_CONCURRENCY,
      activeBuilds: activeBuildCount(),
      dockerAvailable: dockerReady,
    },
  }),
});
metrics.start();

log.info(
  {
    workerId,
    name: registry.name,
    concurrency: env.WORKER_CONCURRENCY,
    queues: ['deployments', 'container-actions'],
    docker: dockerReady,
    metricsIntervalMs: env.METRICS_INTERVAL_MS,
    jobLockMs: env.DEPLOY_JOB_LOCK_MS,
    stallIntervalMs: env.DEPLOY_JOB_STALL_INTERVAL_MS,
  },
  'forgecloud worker started',
);

/**
 * Graceful shutdown (CLAUDE.md §4): stop taking new jobs, let in-flight
 * deployments finish, then release every handle. A hard timer guarantees the
 * process still exits if something refuses to close.
 */
async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(
    { reason, activeJobs: registry.activeCount, activeBuilds: activeBuildCount() },
    'shutting down',
  );

  const forceExit = setTimeout(() => {
    log.error({ timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, 'graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await registry.drain();
    // A build can run for minutes and the force-exit timer above is seconds
    // away, so in-flight builds are stopped rather than waited for: the step
    // throws, the deployment is recorded as failed with that reason, and the
    // retry lands on whoever is still alive. Exiting without this would leave
    // orphaned `npm` process trees holding sandboxes we are about to delete.
    monitor.stop();
    reaper.stop();
    metrics.stop();
    const builds = abortAllBuilds();
    if (builds > 0) log.warn({ builds }, 'aborted in-flight builds');
    // close() stops fetching new jobs and waits for active ones to finish. A
    // job still running when the force-timer fires is left locked, and BullMQ
    // hands it to another worker once the lock expires.
    // Containers of *live* deployments are deliberately left running: they are
    // the deployed apps, and a worker restart must not take a user's site down.
    // Only the pipelines in flight above are stopped.
    await Promise.allSettled([queueWorker.close(), actionWorker.close()]);
    await registry.unregister();
    // Drop the metrics document too, so a worker stopped on purpose leaves the
    // dashboard immediately rather than lingering until its TTL expires.
    await forgetProcessMetrics(registry.name);
    await closeCompressionPool();
    await Promise.allSettled([closeQueue(), closeDb(), closeRedis()]);
    log.info('shutdown complete');
    clearTimeout(forceExit);
    process.exit(exitCode);
  } catch (err) {
    log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

process.on('unhandledRejection', (reason) => {
  log.fatal({ err: reason }, 'unhandled rejection');
  void shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception');
  void shutdown('uncaughtException', 1);
});
