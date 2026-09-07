import { createLogger, env } from '@forge/config';
import { closeDb, pingDb, workerRepo } from '@forge/db';
import { closeQueue, configureQueue, createDeploymentWorker } from '@forge/queue';
import { closeCompressionPool } from '@forge/storage';
import { closeRedis, openRedis } from './lib/redis.js';
import { WorkerRegistry } from './services/worker-registry.js';
import { createProcessor } from './processor.js';

/**
 * A ForgeCloud worker process.
 *
 * It serves no HTTP: it registers itself, consumes the `deployments` queue and
 * runs the pipeline. Run several of these against the same Redis and BullMQ
 * hands each job to exactly one of them — that is the whole local-scaling
 * story (ARCHITECTURE §7).
 */
const log = createLogger('worker', { base: { service: 'worker', pid: process.pid } });

configureQueue({
  redisUrl: env.REDIS_URL,
  attempts: env.DEPLOY_JOB_ATTEMPTS,
  backoffMs: env.DEPLOY_JOB_BACKOFF_MS,
  operationTimeoutMs: env.QUEUE_OPERATION_TIMEOUT_MS,
});

const registry = new WorkerRegistry(log);

// Fail loudly at boot rather than on the first job.
await pingDb();
await openRedis();

// Housekeeping: forget worker rows from processes that died long ago and never
// ran anything, so the fleet view stays readable across restarts.
const pruned = await workerRepo.pruneStaleWorkers(env.WORKER_HEARTBEAT_MS * 240);
if (pruned > 0) log.info({ pruned }, 'pruned stale worker registrations');

const workerId = await registry.register();

/** Set by `shutdown()`; read by the consumer-loop handler below. */
let shuttingDown = false;

const queueWorker = createDeploymentWorker({
  concurrency: env.WORKER_CONCURRENCY,
  lockDurationMs: env.DEPLOY_JOB_LOCK_MS,
  processor: createProcessor(registry, log),
});

queueWorker.on('failed', (job, err) => {
  log.warn({ jobId: job?.id, attempt: job?.attemptsMade, err }, 'job failed');
});
queueWorker.on('completed', (job) => {
  log.debug({ jobId: job.id }, 'job completed');
});
queueWorker.on('stalled', (jobId) => {
  // The previous owner stopped renewing its lock — this is the crash-recovery
  // path Phase 10 demonstrates.
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

log.info(
  { workerId, name: registry.name, concurrency: env.WORKER_CONCURRENCY, queue: 'deployments' },
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
  log.info({ reason, activeJobs: registry.activeCount }, 'shutting down');

  const forceExit = setTimeout(() => {
    log.error({ timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, 'graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await registry.drain();
    // close() stops fetching new jobs and waits for active ones to finish. A
    // job still running when the force-timer fires is left locked, and BullMQ
    // hands it to another worker once the lock expires.
    await queueWorker.close();
    await registry.unregister();
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
