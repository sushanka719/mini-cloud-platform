import {
  REDIS_CHANNELS,
  conflict,
  notFound,
  serviceUnavailable,
  type CreateDeploymentInput,
  type Deployment,
  type DeploymentEvent,
  type DeploymentListQuery,
  type DeploymentStatusMessage,
} from '@forge/shared';
import { deploymentRepo, type DeploymentRow, type ProjectRow } from '@forge/db';
import { enqueueDeployment } from '@forge/queue';
import { listProjectFiles } from '../repositories/file-repository.js';
import { getPublisherRedis } from '../lib/redis.js';
import { toDeployment, toDeploymentEvent } from './serializers.js';

/**
 * Creating a deployment is the API's only write into the pipeline. It never
 * builds anything (ARCHITECTURE §2.2): it records the intent in Postgres,
 * publishes the initial `queued` transition, and hands a pointer to BullMQ.
 */

/** Postgres unique-violation — the concurrent-duplicate race. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '23505';
}

/**
 * Resolves what this deployment is *of*.
 *
 * Upload projects deploy a stored object, so the source ref is that object's
 * id — which makes the idempotency tuple meaningful: "the same source, with
 * the same key, is the same deployment".
 */
async function resolveSource(
  project: ProjectRow,
  input: CreateDeploymentInput,
): Promise<{ sourceRef: string | null; sourceFileId: string | null }> {
  if (project.source_type === 'git') {
    return { sourceRef: input.sourceRef ?? 'HEAD', sourceFileId: null };
  }

  if (input.sourceFileId) {
    const files = await listProjectFiles(project.id, 'source', 200);
    const chosen = files.find((f) => f.id === input.sourceFileId);
    if (!chosen) throw notFound('SOURCE_NOT_FOUND', 'That source archive does not exist');
    return { sourceRef: chosen.id, sourceFileId: chosen.id };
  }

  const [newest] = await listProjectFiles(project.id, 'source', 1);
  if (!newest) {
    throw conflict('NO_SOURCE', 'Upload a source archive before deploying this project');
  }
  return { sourceRef: newest.id, sourceFileId: newest.id };
}

/** Persists a transition event and publishes it, in that order. */
async function recordQueued(row: DeploymentRow, message: string): Promise<void> {
  const event = await deploymentRepo.insertDeploymentEvent({
    deploymentId: row.id,
    type: 'status',
    status: row.status,
    message,
  });

  const payload: DeploymentStatusMessage = {
    type: 'status',
    deploymentId: row.id,
    projectId: row.project_id,
    orgId: row.org_id,
    status: row.status,
    eventId: Number(event.id),
    message,
    at: new Date().toISOString(),
  };
  // Publishing is best-effort: the durable record is already in Postgres, and
  // a dashboard that missed the frame re-reads the timeline on reconnect.
  try {
    const redis = getPublisherRedis();
    const body = JSON.stringify(payload);
    await redis.publish(REDIS_CHANNELS.deployment(row.id), body);
    await redis.publish(REDIS_CHANNELS.project(row.project_id), body);
    await redis.publish(REDIS_CHANNELS.org(row.org_id), body);
  } catch {
    // Swallowed deliberately — see above. /health surfaces a dead Redis.
  }
}

export type CreateDeploymentResult = { deployment: Deployment; created: boolean };

export async function createDeployment(
  project: ProjectRow,
  triggeredBy: string | null,
  input: CreateDeploymentInput,
): Promise<CreateDeploymentResult> {
  const { sourceRef, sourceFileId } = await resolveSource(project, input);
  const idempotencyKey = input.idempotencyKey ?? null;

  // Fast path: the caller replayed a request we already have.
  if (idempotencyKey) {
    const existing = await deploymentRepo.findByIdempotencyKey(
      project.id,
      sourceRef,
      idempotencyKey,
    );
    if (existing) return { deployment: toDeployment(existing), created: false };
  }

  let row: DeploymentRow;
  try {
    row = await deploymentRepo.insertDeployment({
      projectId: project.id,
      orgId: project.org_id,
      sourceRef,
      sourceFileId,
      idempotencyKey,
      triggeredBy,
      failAt: input.failAt ?? null,
    });
  } catch (err) {
    // Two identical requests in flight at once: the index arbitrated, so the
    // loser reads back the winner's row instead of erroring.
    if (isUniqueViolation(err) && idempotencyKey) {
      const existing = await deploymentRepo.findByIdempotencyKey(
        project.id,
        sourceRef,
        idempotencyKey,
      );
      if (existing) return { deployment: toDeployment(existing), created: false };
    }
    throw err;
  }

  await recordQueued(row, 'Deployment created and queued');

  try {
    // The BullMQ job id is the deployment id. That id is fresh here, so no
    // stale job record can shadow the add — a re-enqueue of an *existing*
    // deployment (Phase 8's retry/rollback) must call `forgetDeploymentJob`
    // first, or BullMQ silently ignores it.
    await enqueueDeployment({
      deploymentId: row.id,
      projectId: row.project_id,
      orgId: row.org_id,
      sourceFileId: row.source_file_id,
      triggeredBy: row.triggered_by,
      failAt: row.fail_at,
    });
  } catch (err) {
    // A `queued` row nothing will ever pick up is worse than an error: mark it
    // failed here so the dashboard shows the truth (CLAUDE.md §10).
    const failed = await deploymentRepo.updateDeployment(row.id, {
      status: 'failed',
      error_code: 'ENQUEUE_FAILED',
      error_message: 'Could not enqueue the deployment job',
      finished_at: new Date(),
    });
    if (failed) await recordQueued(failed, 'Could not enqueue the deployment job');
    throw serviceUnavailable(
      'QUEUE_UNAVAILABLE',
      'The deployment queue is unavailable; the deployment was not started',
      err,
    );
  }

  return { deployment: toDeployment(row), created: true };
}

export async function getDeployments(
  projectId: string,
  query: DeploymentListQuery,
): Promise<Deployment[]> {
  const rows = await deploymentRepo.listDeployments(projectId, {
    limit: query.limit,
    ...(query.status ? { status: query.status } : {}),
  });
  return rows.map(toDeployment);
}

export async function requireDeployment(
  projectId: string,
  deploymentId: string,
): Promise<DeploymentRow> {
  const row = await deploymentRepo.findDeployment(projectId, deploymentId);
  if (!row) throw notFound('DEPLOYMENT_NOT_FOUND', 'Deployment not found');
  return row;
}

export async function getDeployment(
  projectId: string,
  deploymentId: string,
): Promise<Deployment> {
  return toDeployment(await requireDeployment(projectId, deploymentId));
}

export async function getDeploymentEvents(
  projectId: string,
  deploymentId: string,
  options: { afterId?: number; limit: number },
): Promise<DeploymentEvent[]> {
  await requireDeployment(projectId, deploymentId);
  const rows = await deploymentRepo.listDeploymentEvents(deploymentId, options);
  return rows.map(toDeploymentEvent);
}

export async function getOrgDeployments(orgId: string, limit: number): Promise<Deployment[]> {
  return (await deploymentRepo.listOrgDeployments(orgId, limit)).map(toDeployment);
}
