import { deploymentRepo, type DeploymentRow, getDb } from '@forge/db';
import type { Logger } from '@forge/config';
import { deploymentJobSchema, isTerminalStatus, type DeploymentJob } from '@forge/shared';
import type { Job } from '@forge/queue';
import { failDeployment, transition } from './services/deployment-state.js';
import { runSimulatedPipeline, StageError } from './pipeline/simulated-pipeline.js';
import type { WorkerRegistry } from './services/worker-registry.js';

/**
 * The BullMQ processor. One job = one deployment.
 *
 * The job payload is only a pointer: the deployment row is re-read here, so a
 * job that waited in the queue while the project changed still builds what the
 * database currently says (CLAUDE.md §4).
 */
export function createProcessor(registry: WorkerRegistry, log: Logger) {
  return async function processDeployment(job: Job<DeploymentJob>): Promise<void> {
    const payload = deploymentJobSchema.parse(job.data);
    const attempt = job.attemptsMade + 1;
    const jobLog = log.child({ deploymentId: payload.deploymentId, jobId: job.id, attempt });

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

    // A retry arrives on a row that is already `failed`. `failed → queued` is a
    // legal transition, so re-queue it rather than forcing the claim.
    if (isTerminalStatus(row.status)) {
      if (attempt === 1) {
        jobLog.info({ status: row.status }, 'deployment already finished; skipping');
        return;
      }
      row = await transition(row, 'queued', {
        message: `Retrying (attempt ${attempt})`,
      });
    }

    // Conditional claim: if another worker got there first, this returns
    // nothing and we leave the job alone rather than double-running it.
    const claimed = await deploymentRepo.claimDeployment(row.id, registry.workerId, attempt);
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
        message: `Assigned to worker ${registry.name}`,
      });

      const project = await getDb()
        .selectFrom('projects')
        .selectAll()
        .where('id', '=', assigned.project_id)
        .executeTakeFirst();
      if (!project) throw new StageError('PROJECT_GONE', 'The project was deleted mid-deployment');

      const live = await runSimulatedPipeline(assigned, project, jobLog);

      // The project's active deployment is the one that just went live.
      await deploymentRepo.setActiveDeployment(live.project_id, live.id);
      jobLog.info({ durationMs: live.duration_ms }, 'deployment live');
    } catch (err) {
      await recordFailure(claimed, err, jobLog);
      // Rethrow so BullMQ marks the job failed: that drives the queue's failed
      // count today and the retry/dead-letter path in Phase 8.
      throw err;
    } finally {
      registry.jobFinished(claimed.id);
    }
  };
}

async function recordFailure(row: DeploymentRow, err: unknown, log: Logger): Promise<void> {
  const code = err instanceof StageError ? err.code : 'PIPELINE_ERROR';
  const message = err instanceof Error ? err.message : String(err);
  try {
    // Re-read: the row has moved on since we claimed it, and `failed` must be
    // recorded from wherever the pipeline actually stopped.
    const current = (await deploymentRepo.findDeploymentById(row.id)) ?? row;
    await failDeployment(current, code, message, log);
  } catch (nested) {
    // Postgres is down as well. Log loudly; the job still fails, and the
    // stalled/failed record in BullMQ remains the trail.
    log.error({ err: nested, originalError: message }, 'could not record deployment failure');
  }
}
