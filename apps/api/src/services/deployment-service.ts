import {
  REDIS_CHANNELS,
  conflict,
  deadLetterJobSchema,
  isTerminalStatus,
  notFound,
  serviceUnavailable,
  type CreateDeploymentInput,
  type CreateRollbackInput,
  type DeadLetterEntry,
  type Deployment,
  type DeploymentEvent,
  type DeploymentListQuery,
  type DeploymentStatusMessage,
  type RetryResult,
  type RollbackTarget,
  type StoredFile,
} from '@forge/shared';
import { env } from '@forge/config';
import {
  deploymentRepo,
  fileRepo,
  getDb,
  type DeploymentRow,
  type ProjectRow,
  type RollbackTargetRow,
} from '@forge/db';
import {
  discardDeadLetter,
  enqueueDeployment,
  forgetDeploymentJob,
  listDeadLetters,
} from '@forge/queue';
import { getPublisherRedis } from '../lib/redis.js';
import { toDeployment, toDeploymentEvent, toStoredFile } from './serializers.js';

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
    const files = await fileRepo.listProjectFiles(project.id, 'source', 200);
    const chosen = files.find((f) => f.id === input.sourceFileId);
    if (!chosen) throw notFound('SOURCE_NOT_FOUND', 'That source archive does not exist');
    return { sourceRef: chosen.id, sourceFileId: chosen.id };
  }

  const [newest] = await fileRepo.listProjectFiles(project.id, 'source', 1);
  if (!newest) {
    throw conflict('NO_SOURCE', 'Upload a source archive before deploying this project');
  }
  return { sourceRef: newest.id, sourceFileId: newest.id };
}

/**
 * Persists a transition event for the row's *current* status and publishes it.
 *
 * Used by all three ways into the pipeline — a fresh deploy, a rollback and a
 * manual retry — because in every one of them the API is the process that put
 * the row in `queued`, so the API is the process that owes the timeline an
 * entry saying so.
 */
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
      // Stamped on the row, not looked up later: `DEPLOY_JOB_ATTEMPTS` can
      // change between this deployment and the next, and "attempt 2 of 3" has
      // to keep meaning the 3 that applied here.
      maxAttempts: env.DEPLOY_JOB_ATTEMPTS,
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

  await enqueueOrFail(row, { fresh: true });

  return { deployment: toDeployment(row), created: true };
}

/**
 * Hands a queued row to BullMQ, or records the truth if it can't.
 *
 * A `queued` row nothing will ever pick up is worse than an error, so a failed
 * enqueue writes `ENQUEUE_FAILED` onto the row before the 503 goes out
 * (CLAUDE.md §10). All three entry points share it: what "the queue is down"
 * means does not depend on why we were enqueuing.
 *
 * `fresh` is the important flag. The BullMQ job id **is** the deployment id, so
 * a brand-new deployment can never collide — but re-enqueuing an *existing*
 * one (a retry, or a rollback that replays an idempotency key) usually can:
 * BullMQ keeps failed jobs for inspection and silently ignores an `add` for an
 * id it still holds. `forgetDeploymentJob` drops that record first. Skipping it
 * is the bug that makes a Retry button do nothing at all.
 */
async function enqueueOrFail(row: DeploymentRow, options: { fresh: boolean }): Promise<void> {
  try {
    if (!options.fresh) await forgetDeploymentJob(row.id);
    await enqueueDeployment({
      deploymentId: row.id,
      projectId: row.project_id,
      orgId: row.org_id,
      sourceFileId: row.source_file_id,
      triggeredBy: row.triggered_by,
      failAt: row.fail_at,
    });
  } catch (err) {
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

/**
 * Objects one deployment produced: its build log today, its artifact from
 * Phase 7. Scoped through `requireDeployment` so a deployment id from another
 * project resolves to "not found" before any file is listed.
 */
export async function getDeploymentFiles(
  projectId: string,
  deploymentId: string,
): Promise<StoredFile[]> {
  await requireDeployment(projectId, deploymentId);
  return (await fileRepo.listDeploymentFiles(deploymentId)).map(toStoredFile);
}

export async function getOrgDeployments(orgId: string, limit: number): Promise<Deployment[]> {
  return (await deploymentRepo.listOrgDeployments(orgId, limit)).map(toDeployment);
}

/**
 * What one worker has built for this org — the fleet page's drill-down
 * (Phase 10).
 *
 * Org-scoped, because a worker is shared infrastructure: it builds for every
 * tenant on the host, and the answer to "what has this process run" must still
 * be the caller's slice of it. There is deliberately no 404 for an unknown
 * worker id — an empty list is the correct and non-enumerable answer, and it is
 * also the honest one for a worker whose registry row was pruned.
 */
export async function getWorkerDeployments(
  orgId: string,
  workerId: string,
  limit: number,
): Promise<Deployment[]> {
  return (await deploymentRepo.listWorkerDeployments(workerId, orgId, limit)).map(toDeployment);
}

// --- Retry (Phase 8) --------------------------------------------------------

/**
 * Re-runs a failed deployment on the same row.
 *
 * Same row, `attempt` incremented, rather than a new deployment with a parent
 * pointer: an automatic retry and a clicked one are the same event — "try this
 * deployment again" — and giving them different shapes in the history would
 * make the build list unreadable. One row per deploy *intent*, carrying its
 * attempt count, is what the dashboard renders.
 *
 * `enqueued: false` is a real outcome rather than an error. Retrying something
 * that is already running has got what it asked for, and a 409 on a
 * double-clicked button would look like a failure to the person clicking it.
 * The race is settled in Postgres: `requeueForRetry` is conditional on the row
 * still being `failed`, so the second of two simultaneous retries matches no
 * rows and is told so.
 */
export async function retryDeployment(
  project: ProjectRow,
  deploymentId: string,
): Promise<RetryResult> {
  const row = await requireDeployment(project.id, deploymentId);

  const refuse = (message: string): RetryResult => ({
    deploymentId: row.id,
    enqueued: false,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    message,
  });

  if (row.status !== 'failed') {
    // `live` first: it is not in `TERMINAL_DEPLOYMENT_STATUSES` (a live
    // deployment can still be stopped or rolled back), so the in-flight branch
    // below would otherwise call it "already running", which reads as though a
    // build were in progress.
    if (row.status === 'live') {
      return refuse('This deployment is live. Deploy again to build a new one.');
    }
    if (!isTerminalStatus(row.status)) {
      return refuse(`This deployment is still running (${row.status}); nothing to retry`);
    }
    return refuse(
      `Only a failed deployment can be retried; this one is "${row.status}". Roll back to it or deploy again.`,
    );
  }

  const requeued = await deploymentRepo.requeueForRetry(row.id, env.DEPLOY_JOB_ATTEMPTS);
  if (!requeued) {
    // Lost the conditional update — another retry got there first.
    return refuse('A retry of this deployment is already in flight');
  }

  const nextAttempt = requeued.attempt + 1;
  await recordQueued(
    requeued,
    `Retry requested (attempt ${String(nextAttempt)} of ${String(requeued.max_attempts)})`,
  );
  await enqueueOrFail(requeued, { fresh: false });

  return {
    deploymentId: requeued.id,
    enqueued: true,
    attempt: nextAttempt,
    maxAttempts: requeued.max_attempts,
    message: `Queued as attempt ${String(nextAttempt)} of ${String(requeued.max_attempts)}`,
  };
}

// --- Rollback (Phase 8) -----------------------------------------------------

function toRollbackTarget(row: RollbackTargetRow): RollbackTarget {
  const iso = (value: Date | string | null): string | null =>
    value === null ? null : new Date(value as unknown as string).toISOString();
  return {
    deploymentId: row.id,
    status: row.status,
    attempt: row.attempt,
    imageTag: row.image_tag,
    sourceRef: row.source_ref,
    // "Recorded", not "present": the API cannot ask Docker whether the image
    // still exists (ARCHITECTURE §9), and a tag outliving its image is normal
    // once `DOCKER_KEEP_IMAGES` has been passed. The worker checks for real and
    // falls back to the artifact, which is why both flags are reported.
    hasImage: row.image_tag !== null,
    hasArtifact: row.artifact_file_id !== null,
    artifactBytes: row.artifact_bytes,
    liveAt: iso(row.live_at),
    createdAt: iso(row.created_at as unknown as Date) ?? new Date(0).toISOString(),
  };
}

/**
 * Deployments of this project that can be rolled back to, newest first.
 *
 * The list is the same predicate the rollback endpoint enforces, so the
 * dashboard offering a target and the API accepting it can't disagree.
 */
export async function getRollbackTargets(
  projectId: string,
  limit: number,
): Promise<RollbackTarget[]> {
  const rows = await deploymentRepo.listRollbackTargets(projectId, limit);
  return rows.map(toRollbackTarget);
}

/**
 * Rolls a project back to one of its previous deployments.
 *
 * Creates a **new** deployment row pointing at the target through
 * `parent_deployment_id`, with the target's `image_tag` and source copied onto
 * it. A new row rather than reviving the old one, because:
 *
 *  - the rollback has its own attempt, its own container, its own timeline and
 *    its own health check, and burying those in a row that already finished
 *    would destroy the record of the original;
 *  - the target has to survive as the thing being pointed *at*;
 *  - `rolled_back` can then be recorded on the deployment that was rejected,
 *    which is the question the history is actually asked.
 *
 * The worker reads `parent_deployment_id` and takes the rollback path: reuse
 * the image if it is still on the host, else rebuild from the stored artifact.
 * That decision is deliberately the worker's, not the API's — only the worker
 * can see the Docker host.
 */
export async function rollbackToDeployment(
  project: ProjectRow,
  targetId: string,
  triggeredBy: string | null,
  input: CreateRollbackInput,
): Promise<CreateDeploymentResult> {
  const target = await requireDeployment(project.id, targetId);

  if (project.active_deployment_id === target.id) {
    throw conflict(
      'ALREADY_ACTIVE',
      'This deployment is the one currently serving the project; there is nothing to roll back',
    );
  }
  // The same predicate `listRollbackTargets` filters on: served once, not now.
  if (target.status !== 'stopped' && target.status !== 'rolled_back') {
    throw conflict(
      'NOT_ROLLBACK_TARGET',
      `Only a deployment that went live and has since been replaced can be rolled back to; this one is "${target.status}"`,
    );
  }

  const artifact = (await fileRepo.listDeploymentFiles(target.id)).find(
    (file) => file.kind === 'artifact',
  );
  if (target.image_tag === null && !artifact) {
    throw conflict(
      'ROLLBACK_SOURCE_GONE',
      'That deployment kept neither an image nor an artifact, so there is nothing to roll back to',
    );
  }

  // Idempotency uses the same tuple a deploy does — (project, source_ref, key)
  // — because a rollback *is* a deployment of that source, and the dashboard
  // mints a fresh key per click. Two clicks are two rollbacks; one click
  // retried by the browser is one.
  const idempotencyKey = input.idempotencyKey ?? null;
  if (idempotencyKey) {
    const existing = await deploymentRepo.findByIdempotencyKey(
      project.id,
      target.source_ref,
      idempotencyKey,
    );
    if (existing) return { deployment: toDeployment(existing), created: false };
  }

  let row: DeploymentRow;
  try {
    row = await deploymentRepo.insertDeployment({
      projectId: project.id,
      orgId: project.org_id,
      sourceRef: target.source_ref,
      sourceFileId: target.source_file_id,
      idempotencyKey,
      triggeredBy,
      // No injected-failure hook on a rollback: it is the thing you reach for
      // *because* something else failed, and a rollback that can be told to
      // fail is a demo of nothing.
      failAt: null,
      maxAttempts: env.DEPLOY_JOB_ATTEMPTS,
      parentDeploymentId: target.id,
      // Copied onto the new row rather than read from the target at run time,
      // so the rollback still knows what to reuse if the target row is
      // retried, restarted or otherwise moves on while this one is queued.
      imageTag: target.image_tag,
    });
  } catch (err) {
    if (isUniqueViolation(err) && idempotencyKey) {
      const existing = await deploymentRepo.findByIdempotencyKey(
        project.id,
        target.source_ref,
        idempotencyKey,
      );
      if (existing) return { deployment: toDeployment(existing), created: false };
    }
    throw err;
  }

  await recordQueued(
    row,
    `Rollback to deployment ${target.id.slice(0, 8)} created and queued ` +
      `(${target.image_tag !== null ? `image ${target.image_tag}` : 'from its stored artifact'})`,
  );
  await enqueueOrFail(row, { fresh: true });

  return { deployment: toDeployment(row), created: true };
}

// --- Dead letters (Phase 8) -------------------------------------------------

/**
 * The org's parked deployments.
 *
 * Filtered by `orgId` **in this process**, not by the queue: BullMQ has no
 * notion of a tenant, so `deployments-dlq` holds every org's entries in one
 * list. Reading the whole (bounded) queue and dropping what isn't ours is the
 * only correct way to serve this — returning the raw list would leak other
 * tenants' deployment and project ids to any member who can name an org.
 *
 * Each entry is enriched with the deployment's status *now*, which is often
 * not `failed`: a dead-lettered deployment that was later retried successfully
 * says `live`, and seeing that is how someone knows the entry is stale and can
 * be discarded.
 */
export async function getOrgDeadLetters(
  orgId: string,
  limit: number,
): Promise<DeadLetterEntry[]> {
  const jobs = await listDeadLetters(env.DEPLOY_DLQ_KEEP);

  const parsed = jobs.flatMap((job) => {
    const result = deadLetterJobSchema.safeParse(job.data);
    // An entry written by an older worker is skipped rather than rendered: the
    // queue is durable across deploys of ForgeCloud itself.
    if (!result.success || result.data.orgId !== orgId) return [];
    return [{ jobId: String(job.id), data: result.data }];
  });
  const window = parsed.slice(0, limit);
  if (window.length === 0) return [];

  // One query for the current statuses and project names rather than two per
  // entry: this endpoint is polled by the fleet page.
  const rows = await getDb()
    .selectFrom('deployments')
    .innerJoin('projects', 'projects.id', 'deployments.project_id')
    .select(['deployments.id', 'deployments.status', 'projects.name as project_name'])
    .where(
      'deployments.id',
      'in',
      window.map((entry) => entry.data.deploymentId),
    )
    .where('deployments.org_id', '=', orgId)
    .execute();
  const current = new Map(rows.map((row) => [row.id, row]));

  return window.map(({ jobId, data }) => {
    const now = current.get(data.deploymentId);
    return {
      ...data,
      jobId,
      // Null when the deployment row is gone (its project was deleted): the
      // entry outlives what it describes, which is exactly what a parking lot
      // is for.
      currentStatus: now?.status ?? null,
      projectName: now?.project_name ?? null,
    };
  });
}

/**
 * Discards one parked entry.
 *
 * Ownership is checked against the entry's own `orgId` before anything is
 * removed — a job id is guessable, and this is a cross-tenant list under the
 * hood.
 */
export async function discardOrgDeadLetter(orgId: string, jobId: string): Promise<void> {
  const jobs = await listDeadLetters(env.DEPLOY_DLQ_KEEP);
  const match = jobs.find((job) => String(job.id) === jobId);
  const parsed = match ? deadLetterJobSchema.safeParse(match.data) : null;
  if (!parsed?.success || parsed.data.orgId !== orgId) {
    throw notFound('DEAD_LETTER_NOT_FOUND', 'That dead-letter entry does not exist');
  }
  await discardDeadLetter(jobId);
}
