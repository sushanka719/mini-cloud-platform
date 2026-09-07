import { deploymentRepo, type DeploymentRow, getDb } from '@forge/db';
import type { Logger } from '@forge/config';
import {
  WORKER_LOST_CODE,
  deploymentJobSchema,
  isInFlightStatus,
  isTerminalStatus,
  type DeploymentJob,
} from '@forge/shared';
import { enqueueDeadLetter, UnrecoverableError, type Job } from '@forge/queue';
import { failDeployment, logLine, transition } from './services/deployment-state.js';
import { runDeployPipeline } from './pipeline/deploy-pipeline.js';
import { StageError } from './pipeline/stage-error.js';
import type { WorkerRegistry } from './services/worker-registry.js';
import { workerLiveness } from './services/worker-liveness.js';

/**
 * The BullMQ processor. One job = one deployment.
 *
 * The job payload is only a pointer: the deployment row is re-read here, so a
 * job that waited in the queue while the project changed still builds what the
 * database currently says (CLAUDE.md §4).
 *
 * Phase 8 gave this function the retry decision. BullMQ owns *whether* a job
 * runs again — it holds the attempt counter and the backoff timer — so all the
 * processor does is tell it which of three things happened:
 *
 *  - **throw the error** → retryable, budget left: BullMQ re-queues it after
 *    the backoff, possibly onto a different worker.
 *  - **throw `UnrecoverableError`** → this failure will fail again (a build
 *    that exited non-zero, a git project we can't clone). The remaining
 *    attempts are abandoned rather than spent proving the same thing twice.
 *  - **return** → success.
 *
 * In both failure cases the deployment row is already recorded as `failed`
 * with its reason, and when the job will not run again its record is parked in
 * `deployments-dlq` first.
 *
 * Phase 10 added the fourth case, which is not a failure at all: the job is
 * arriving here because the worker that had it *died*. BullMQ re-delivers a job
 * whose lock stopped being renewed, and the row it points at still says
 * `installing` and still names a process that no longer exists. Recovering
 * from that is `takeOverAbandoned()` below.
 */
export function createProcessor(registry: WorkerRegistry, log: Logger) {
  return async function processDeployment(job: Job<DeploymentJob>): Promise<void> {
    const payload = deploymentJobSchema.parse(job.data);
    // BullMQ's counter, not the row's: it is what governs the retries, and a
    // manual re-enqueue is a *new* job that legitimately gets a fresh budget.
    const jobAttempt = job.attemptsMade + 1;
    const jobAttempts = job.opts.attempts ?? 1;
    const jobLog = log.child({
      deploymentId: payload.deploymentId,
      jobId: job.id,
      jobAttempt,
      jobAttempts,
    });

    let row = await deploymentRepo.findDeploymentById(payload.deploymentId);
    if (!row) {
      // The project (and its deployments) was deleted while the job waited.
      jobLog.warn('deployment row is gone; dropping the job');
      return;
    }

    if (row.status === 'canceled' || row.status === 'stopped') {
      jobLog.info({ status: row.status }, 'deployment is no longer runnable; skipping');
      return;
    }

    // A BullMQ retry arrives on a row the previous attempt already recorded as
    // `failed`. `failed → queued` is a legal transition, so re-queue it rather
    // than forcing the claim — and put the retry in the timeline, because "why
    // is this building again?" should be answerable from the log alone.
    //
    // `job.attemptsMade > 0` is what distinguishes a retry from a stale job for
    // a deployment that genuinely finished: a manual retry re-queues the row in
    // the API *before* enqueuing, so it arrives here as `queued`.
    if (isTerminalStatus(row.status)) {
      // `attemptsMade === 0` normally means "this job has never run, so a
      // terminal row is somebody else's finished work" — except when the row
      // was failed by the orphan sweep. A stall does not increment BullMQ's
      // attempt counter, so a job whose worker died and whose row the sweep
      // then reaped arrives here looking brand new *and* already finished. It
      // is neither: it is the run we are meant to redo.
      if (job.attemptsMade === 0 && row.error_code !== WORKER_LOST_CODE) {
        jobLog.info({ status: row.status }, 'deployment already finished; skipping');
        return;
      }
      row = await transition(row, 'queued', {
        message: `Retrying automatically after ${row.error_code ?? 'a failure'} (queue attempt ${String(jobAttempt)} of ${String(jobAttempts)})`,
        // The previous attempt's outcome is not this row's outcome any more.
        // Without this the row stays `live`-with-an-error after a retry
        // succeeds — found in verification, where a deployment recovered on
        // attempt 2 and still reported `BUILD_ABORTED` to the dashboard. The
        // manual retry path (`requeueForRetry`) clears the same columns, and
        // the two have to agree: a retry is a retry however it was triggered.
        // The reason is not lost — it is in `deployment_events`, and in the
        // dead-letter entry if the budget ever runs out.
        patch: {
          error_code: null,
          error_message: null,
          finished_at: null,
          duration_ms: null,
          container_id: null,
          host_port: null,
          url: null,
          dead_lettered_at: null,
        },
      });
    }

    // The row is mid-pipeline. Either its worker is alive and we must not
    // touch it, or its worker is gone and this job is a stall recovery.
    if (isInFlightStatus(row.status)) {
      const recovered = await takeOverAbandoned(row, registry, jobLog);
      if (!recovered) return;
      row = recovered;
    }

    // Conditional claim: if another worker got there first, this returns
    // nothing and we leave the job alone rather than double-running it. The
    // row's own `attempt` counter is incremented inside the same update.
    const claimed = await deploymentRepo.claimDeployment(row.id, registry.workerId);
    if (!claimed) {
      jobLog.warn({ status: row.status }, 'could not claim deployment; another worker has it');
      return;
    }

    registry.jobStarted(claimed.id);
    try {
      // `claimDeployment` wrote the status directly (it has to be conditional),
      // so record the matching event + publish here.
      const assigned = await transition(claimed, 'assigned', {
        force: true,
        message:
          `Assigned to worker ${registry.name} (attempt ${String(claimed.attempt)}` +
          `${claimed.max_attempts > 1 ? ` of ${String(claimed.max_attempts)}` : ''})`,
      });

      const project = await getDb()
        .selectFrom('projects')
        .selectAll()
        .where('id', '=', assigned.project_id)
        .executeTakeFirst();
      if (!project) throw new StageError('PROJECT_GONE', 'The project was deleted mid-deployment');

      const { deployment: live, logFile } = await runDeployPipeline(assigned, project, jobLog);

      // The active-deployment pointer is *not* set here any more. From Phase 7
      // it moves inside the pipeline, under the project lock and between the
      // `live` write and the removal of the old container — a window this far
      // out cannot cover, and one where a gap means the project briefly points
      // at nothing.
      jobLog.info(
        {
          durationMs: live.duration_ms,
          logFileId: logFile?.id ?? null,
          containerId: live.container_id,
          url: live.url,
          attempt: live.attempt,
        },
        'deployment live',
      );
    } catch (err) {
      const failure = classify(err);
      const failed = await recordFailure(claimed, failure, jobLog);
      const willRetry = failure.retryable && jobAttempt < jobAttempts;

      if (willRetry) {
        jobLog.warn(
          { code: failure.code, nextAttempt: jobAttempt + 1 },
          'deployment failed; the queue will retry it',
        );
        // Rethrown as-is: BullMQ marks the job failed, waits out the
        // exponential backoff and re-delivers it.
        throw err;
      }

      await deadLetter(failed ?? claimed, failure, jobAttempt, registry, jobLog);
      // Ends the job here. Without this a non-retryable failure would burn its
      // remaining attempts re-proving that `npm run build` still exits 1.
      throw new UnrecoverableError(
        `${failure.code}: ${failure.message} (${failure.retryable ? 'retry budget exhausted' : 'not retryable'})`,
      );
    } finally {
      registry.jobFinished(claimed.id);
    }
  };
}

/**
 * Takes a mid-pipeline deployment away from a worker that no longer exists —
 * the other half of Phase 10's crash story.
 *
 * The job got here because BullMQ stopped seeing its lock renewed and handed it
 * to whoever asked next. The row, meanwhile, is frozen at whatever stage the
 * dead process reached. `claimDeployment` will not touch a row in that state,
 * and that guard is load-bearing: it is what stops two live workers from both
 * building the same deployment. So the row has to go back to `queued` first,
 * and only after proving the previous owner is really gone.
 *
 * Returns the re-queued row, or `null` when this worker must leave the
 * deployment alone. Two ways that happens, and both mean "someone else owns
 * this":
 *
 *  - the previous worker is still heartbeating — a genuinely slow build, or a
 *    lock renewal that lost a race with the stall check. It can also be *this*
 *    process, which BullMQ will do if a long event-loop block cost us a
 *    renewal while the pipeline kept running;
 *  - the conditional re-queue matched no rows, so another worker recovered it
 *    first, or the orphan sweep already recorded it as lost.
 *
 * Returning null ends the job, and that is correct in both: whoever owns the
 * deployment is going to finish it, and there is nothing here to retry.
 *
 * Liveness that could not be *read* is the third case and it throws instead,
 * because neither answer is safe. Returning would complete the job and strand
 * a row nothing owns until the sweep notices; taking over would risk running a
 * second pipeline for a build that is very much alive. Throwing spends one
 * retry attempt and keeps the job, which is the cheap mistake to make.
 *
 * This whole function is what was missing before Phase 10, and the shape of the
 * bug is worth recording: `claimDeployment` refuses a row that is not
 * `queued`/`assigned`, so a re-delivered job hit that refusal, the processor
 * logged it and *returned* — which BullMQ reads as success. The job was marked
 * completed, the row stayed at `installing` forever, and the dashboard showed a
 * spinner with nothing behind it.
 */
async function takeOverAbandoned(
  row: DeploymentRow,
  registry: WorkerRegistry,
  log: Logger,
): Promise<DeploymentRow | null> {
  const previous = row.worker_id;

  if (previous === registry.workerId) {
    if (registry.isRunning(row.id)) {
      log.warn(
        { status: row.status },
        'this worker is still running the deployment this job was re-delivered for; leaving it alone',
      );
      return null;
    }
    // Same registry row, but the pipeline that owned it is gone — the run was
    // aborted (a shutdown that then failed to exit, say). Ours to redo.
    log.warn({ status: row.status }, 'reclaiming a deployment this process abandoned');
  } else {
    const liveness = await workerLiveness(previous);
    if (liveness === 'unknown') {
      // See the note above: the only safe move is to keep the job.
      throw new StageError(
        'WORKER_LIVENESS_UNKNOWN',
        'Could not check whether the worker holding this deployment is still alive',
        { retryable: true },
      );
    }
    if (liveness === 'alive') {
      log.warn(
        { status: row.status, previousWorkerId: previous },
        'the deployment is held by another live worker; leaving it alone',
      );
      return null;
    }
  }

  const reclaimed = await deploymentRepo.reclaimAbandonedDeployment(row.id, previous);
  if (!reclaimed) {
    // Another worker recovered it a moment ago, or the original came back and
    // moved the row on. Either way the conditional update told us so.
    log.info({ status: row.status }, 'lost the race to reclaim the deployment');
    return null;
  }

  const lostWorker = previous ? await workerName(previous) : null;
  // Recorded and published, not just logged: "why did this deployment restart
  // from the beginning?" has to be answerable from the timeline the user can
  // see. `force` because the DB already says `queued` — the conditional update
  // above had to write it to win the race.
  return transition(reclaimed, 'queued', {
    force: true,
    message:
      `Worker ${lostWorker ?? previous?.slice(0, 8) ?? 'unknown'} stopped responding during ` +
      `"${row.status}"; the job was returned to the queue and picked up by ${registry.name}`,
  });
}

/** The dead worker's display name, for the timeline. Best-effort. */
async function workerName(workerId: string): Promise<string | null> {
  try {
    const row = await getDb()
      .selectFrom('workers')
      .select('name')
      .where('id', '=', workerId)
      .executeTakeFirst();
    return row?.name ?? null;
  } catch {
    return null;
  }
}

type Failure = { code: string; message: string; retryable: boolean };

/**
 * Turns whatever was thrown into a code, a safe message and a retry verdict.
 *
 * The pipeline normalises everything it throws into a `StageError` carrying
 * `retryable`, so this is mostly a read. The default for anything that escaped
 * un-normalised is **retryable**: an unclassified error is more likely a
 * transient one (a database blip while claiming, a Docker socket that went
 * away) than a deterministic one, and one wasted retry costs less than a false
 * dead-letter that needs a human.
 */
function classify(err: unknown): Failure {
  if (err instanceof StageError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  return {
    code: 'PIPELINE_ERROR',
    message: err instanceof Error ? err.message : String(err),
    retryable: true,
  };
}

async function recordFailure(
  row: DeploymentRow,
  failure: Failure,
  log: Logger,
): Promise<DeploymentRow | null> {
  try {
    // Re-read: the row has moved on since we claimed it, and `failed` must be
    // recorded from wherever the pipeline actually stopped.
    const current = (await deploymentRepo.findDeploymentById(row.id)) ?? row;
    return await failDeployment(current, failure.code, failure.message, log);
  } catch (nested) {
    // Postgres is down as well. Log loudly; the job still fails, and the
    // stalled/failed record in BullMQ remains the trail.
    log.error({ err: nested, originalError: failure.message }, 'could not record deployment failure');
    return null;
  }
}

/**
 * Parks an exhausted deployment in `deployments-dlq` and says so on its
 * timeline.
 *
 * Two records, deliberately: the queue entry keeps the *job* (payload, attempt,
 * reason) for inspection and a re-drive, and `deployments.dead_lettered_at`
 * keeps the fact in Postgres so the dashboard can show it without reading Redis
 * and so it survives a Redis flush.
 *
 * They are written in two separate `try` blocks, and that is the point: the
 * Postgres half is the one that must land, so a Redis failure has to leave
 * "this was dead-lettered" recorded *and explained on the timeline* rather than
 * taking the note down with it. Found during verification, when a rejected job
 * id lost both halves at once and the dashboard showed a badge with nothing
 * behind it.
 *
 * Never fatal either way. The deployment is already recorded as failed with its
 * reason; failing to file the paperwork must not turn one failure into two.
 */
async function deadLetter(
  row: DeploymentRow,
  failure: Failure,
  jobAttempt: number,
  registry: WorkerRegistry,
  log: Logger,
): Promise<void> {
  try {
    await deploymentRepo.markDeadLettered(row.id);
    await logLine(
      row,
      'system',
      failure.retryable
        ? `All ${String(jobAttempt)} attempts failed; moved to the dead-letter queue. Retry or roll back from the dashboard.`
        : `${failure.code} will not succeed on a retry; moved to the dead-letter queue without spending the remaining attempts.`,
    );
  } catch (err) {
    log.error({ err, deploymentId: row.id }, 'could not record the dead-letter mark');
  }

  try {
    const entry = await enqueueDeadLetter({
      deploymentId: row.id,
      projectId: row.project_id,
      orgId: row.org_id,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      errorCode: failure.code,
      errorMessage: failure.message,
      retryable: failure.retryable,
      failedAt: new Date().toISOString(),
      workerName: registry.name,
    });
    log.warn(
      { code: failure.code, attempt: row.attempt, dlqJobId: entry?.id ?? 'already-parked' },
      'deployment dead-lettered',
    );
  } catch (err) {
    log.error(
      { err, deploymentId: row.id },
      'could not park the deployment in the dead-letter queue',
    );
  }
}
