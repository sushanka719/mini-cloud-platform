import { sql } from 'kysely';
import { getDb } from '../client.js';
import type { DeploymentEventRow, DeploymentRow, DeploymentUpdate, Timestamp } from '../types.js';
import { IN_FLIGHT_DEPLOYMENT_STATUSES, type DeploymentStatus, type LogStream } from '@forge/shared';

/**
 * Deployments and their append-only event timeline.
 *
 * This repository lives in `@forge/db` rather than in `apps/api` because both
 * the API (producer, reader) and the worker (which drives every transition)
 * need it, and ARCHITECTURE §2.5 puts shared repository helpers here. The
 * app-specific repositories stay in their app.
 *
 * Reads are scoped by `project_id` (and, for the org-level views, `org_id`) so
 * a deployment uuid guessed from another tenant resolves to "not found"
 * (DATA_MODEL §5).
 */

/**
 * A deployment row plus the name of the worker that ran it (Phase 10).
 *
 * A LEFT JOIN rather than a second query per row: "which worker ran which
 * deployment" is the whole point of the fleet view, and N+1-ing it for a
 * fifteen-row activity feed that polls every two seconds is not a trade worth
 * making. Left, not inner, because `worker_id` is nullable both before a claim
 * and after `pruneStaleWorkers` has removed the registry row (the FK is
 * ON DELETE SET NULL).
 */
export type DeploymentWithWorkerRow = DeploymentRow & { worker_name: string | null };

/**
 * The join, in one place. Every list/read that feeds the dashboard uses it, so
 * the column list cannot drift between the project view and the org feed.
 */
function selectDeploymentsWithWorker() {
  return getDb()
    .selectFrom('deployments')
    .leftJoin('workers', 'workers.id', 'deployments.worker_id')
    .selectAll('deployments')
    .select('workers.name as worker_name');
}

export type InsertDeploymentInput = {
  projectId: string;
  orgId: string;
  sourceRef: string | null;
  sourceFileId: string | null;
  idempotencyKey: string | null;
  triggeredBy: string | null;
  failAt: DeploymentStatus | null;
  /** The retry budget this row is created under (Phase 8). */
  maxAttempts: number;
  /**
   * Set only by a rollback: the deployment this one goes back to. Its presence
   * is also what tells the worker to skip clone/install/build, which is why it
   * travels with `imageTag` rather than being inferred later.
   */
  parentDeploymentId?: string | null;
  /** Pre-set by a rollback to the target's image; null for a normal deploy. */
  imageTag?: string | null;
};

export async function insertDeployment(input: InsertDeploymentInput): Promise<DeploymentRow> {
  return getDb()
    .insertInto('deployments')
    .values({
      project_id: input.projectId,
      org_id: input.orgId,
      status: 'queued',
      source_ref: input.sourceRef,
      source_file_id: input.sourceFileId,
      idempotency_key: input.idempotencyKey,
      triggered_by: input.triggeredBy,
      fail_at: input.failAt,
      max_attempts: input.maxAttempts,
      parent_deployment_id: input.parentDeploymentId ?? null,
      image_tag: input.imageTag ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function listDeployments(
  projectId: string,
  options: { limit: number; status?: DeploymentStatus },
): Promise<DeploymentWithWorkerRow[]> {
  let query = selectDeploymentsWithWorker().where('project_id', '=', projectId);
  if (options.status) query = query.where('deployments.status', '=', options.status);
  return query.orderBy('deployments.created_at', 'desc').limit(options.limit).execute();
}

export async function findDeployment(
  projectId: string,
  deploymentId: string,
): Promise<DeploymentWithWorkerRow | undefined> {
  return selectDeploymentsWithWorker()
    .where('project_id', '=', projectId)
    .where('deployments.id', '=', deploymentId)
    .executeTakeFirst();
}

/**
 * The idempotency lookup, mirroring the partial unique index exactly:
 * (project_id, coalesce(source_ref,''), idempotency_key).
 */
export async function findByIdempotencyKey(
  projectId: string,
  sourceRef: string | null,
  idempotencyKey: string,
): Promise<DeploymentRow | undefined> {
  return getDb()
    .selectFrom('deployments')
    .selectAll()
    .where('project_id', '=', projectId)
    .where(sql<boolean>`coalesce(source_ref, '') = ${sourceRef ?? ''}`)
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();
}

/** Deployments across a whole org — the org-level activity feed. */
export async function listOrgDeployments(
  orgId: string,
  limit: number,
): Promise<DeploymentWithWorkerRow[]> {
  return selectDeploymentsWithWorker()
    .where('org_id', '=', orgId)
    .orderBy('deployments.created_at', 'desc')
    .limit(limit)
    .execute();
}

/**
 * What one worker has run — the fleet view's drill-down.
 *
 * Scoped by `org_id` as well as by worker, and that is not optional: a worker
 * is infrastructure and happily builds for every tenant on the laptop, so an
 * unscoped version of this query would hand one org's deployment ids to
 * another (DATA_MODEL §5).
 */
export async function listWorkerDeployments(
  workerId: string,
  orgId: string,
  limit: number,
): Promise<DeploymentWithWorkerRow[]> {
  return selectDeploymentsWithWorker()
    .where('deployments.worker_id', '=', workerId)
    .where('deployments.org_id', '=', orgId)
    .orderBy('deployments.created_at', 'desc')
    .limit(limit)
    .execute();
}

// --- events -----------------------------------------------------------------

export type InsertDeploymentEventInput = {
  deploymentId: string;
  type: 'status' | 'log';
  status?: DeploymentStatus | null;
  stream?: LogStream | null;
  message?: string | null;
};

export async function insertDeploymentEvent(
  input: InsertDeploymentEventInput,
): Promise<DeploymentEventRow> {
  return getDb()
    .insertInto('deployment_events')
    .values({
      deployment_id: input.deploymentId,
      type: input.type,
      status: input.status ?? null,
      stream: input.stream ?? null,
      message: input.message ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Appends many events in one round trip, returning them with their ids.
 *
 * Real build output arrives in bursts of hundreds of lines; inserting them one
 * at a time made the database round trip the pipeline's bottleneck. Postgres
 * assigns the identities in the order the rows are given, so the returned ids
 * stay in line order — which matters, because they are also the replay cursor
 * the dashboard de-duplicates on.
 */
export async function insertDeploymentEvents(
  inputs: InsertDeploymentEventInput[],
): Promise<DeploymentEventRow[]> {
  if (inputs.length === 0) return [];
  return getDb()
    .insertInto('deployment_events')
    .values(
      inputs.map((input) => ({
        deployment_id: input.deploymentId,
        type: input.type,
        status: input.status ?? null,
        stream: input.stream ?? null,
        message: input.message ?? null,
      })),
    )
    .returningAll()
    .execute();
}

export async function listDeploymentEvents(
  deploymentId: string,
  options: { afterId?: number; limit: number },
): Promise<DeploymentEventRow[]> {
  let query = getDb()
    .selectFrom('deployment_events')
    .selectAll()
    .where('deployment_id', '=', deploymentId);
  if (options.afterId !== undefined) query = query.where('id', '>', options.afterId);
  return query.orderBy('id', 'asc').limit(options.limit).execute();
}

// --- worker-side writes -----------------------------------------------------

/**
 * Claims a queued deployment for a worker. Conditional on the row still being
 * `queued`, so two workers racing on a re-delivered job can't both claim it —
 * the loser gets `undefined` and skips the job (multi-process shared state,
 * CLAUDE.md §4).
 *
 * `attempt` is incremented **in SQL** rather than passed in (Phase 8). It has
 * to count runs of the row, and the row is re-run from two independent places:
 * BullMQ's own retry (which knows `attemptsMade`) and a manual re-enqueue
 * (which starts a fresh job at `attemptsMade = 0`). Deriving it from the
 * queue's counter would reset it on every manual retry and lose exactly the
 * history the attempt number exists to carry. `attempt + 1` inside the same
 * conditional update is also atomic, so two workers racing produce one
 * increment, not two.
 */
export async function claimDeployment(
  deploymentId: string,
  workerId: string,
): Promise<DeploymentRow | undefined> {
  return getDb()
    .updateTable('deployments')
    .set({
      status: 'assigned',
      worker_id: workerId,
      attempt: sql<number>`attempt + 1`,
      started_at: sql`now()`,
    })
    .where('id', '=', deploymentId)
    .where('status', 'in', ['queued', 'assigned'])
    .returningAll()
    .executeTakeFirst();
}

/**
 * Hands an abandoned in-flight deployment back to the queue (Phase 10).
 *
 * This is the database half of stalled-job recovery. When a worker is SIGKILLed
 * mid-build, its row keeps saying `installing` and keeps naming a process that
 * no longer exists. BullMQ eventually notices the job's lock is not being
 * renewed and re-delivers it — but `claimDeployment` refuses a row that is not
 * `queued`/`assigned`, and rightly so: that guard is what stops two live
 * workers from both running the same deployment. So the new owner has to move
 * the row back to `queued` first, and only if the previous owner really is
 * gone.
 *
 * Conditional on **both** the status being in-flight and `worker_id` still
 * being the worker we found dead. That is what makes it safe to call from
 * several workers at once: the first one wins, and a second — or a stale read
 * where the original worker actually came back and moved on — matches no rows
 * and is told so.
 *
 * `attempt` is *not* incremented here; `claimDeployment` does that a moment
 * later, and counting the takeover as its own attempt would double-count one
 * run. The outcome columns of the abandoned run are cleared for the same
 * reason `requeueForRetry` clears them: a row that is queued must not still be
 * advertising a container and a URL from a run that died.
 */
export async function reclaimAbandonedDeployment(
  deploymentId: string,
  previousWorkerId: string | null,
): Promise<DeploymentRow | undefined> {
  const query = getDb()
    .updateTable('deployments')
    .set({
      status: 'queued',
      worker_id: null,
      container_id: null,
      host_port: null,
      url: null,
      error_code: null,
      error_message: null,
      finished_at: null,
      duration_ms: null,
    })
    .where('id', '=', deploymentId)
    .where('status', 'in', IN_FLIGHT_DEPLOYMENT_STATUSES);
  // An in-flight row with no worker id at all should not exist — a claim
  // writes both columns in one update — but if one ever does it is abandoned
  // by definition, and `= null` matches nothing in SQL.
  return (
    previousWorkerId === null
      ? query.where('worker_id', 'is', null)
      : query.where('worker_id', '=', previousWorkerId)
  )
    .returningAll()
    .executeTakeFirst();
}

/**
 * Records an in-flight deployment as failed because the worker holding it is
 * gone (Phase 10's orphan sweep).
 *
 * Conditional on the same two things `reclaimAbandonedDeployment` is — the
 * status still being in-flight and `worker_id` still being the process we
 * found dead — so several workers running the sweep at once cannot each write
 * the same failure. The winner gets the row back and appends the event; the
 * losers get `undefined` and do nothing.
 *
 * `duration_ms` is computed in SQL from `started_at` rather than in the caller,
 * because the caller has no clock the row agrees with.
 */
export async function abandonDeployment(
  deploymentId: string,
  previousWorkerId: string | null,
  reason: { code: string; message: string },
): Promise<DeploymentRow | undefined> {
  const query = getDb()
    .updateTable('deployments')
    .set({
      status: 'failed',
      error_code: reason.code,
      error_message: reason.message,
      finished_at: sql`now()`,
      duration_ms: sql<number | null>`
        case when started_at is not null
          then (extract(epoch from (now() - started_at)) * 1000)::int
        end
      `,
    })
    .where('id', '=', deploymentId)
    .where('status', 'in', IN_FLIGHT_DEPLOYMENT_STATUSES);
  return (
    previousWorkerId === null
      ? query.where('worker_id', 'is', null)
      : query.where('worker_id', '=', previousWorkerId)
  )
    .returningAll()
    .executeTakeFirst();
}

/**
 * In-flight deployments that have not moved for `staleMs` — the input to the
 * orphan sweep.
 *
 * `updated_at` rather than `started_at`: a healthy build writes the column on
 * every transition, so "has not moved in three minutes" is exactly what this
 * asks. The worker id and name come along so the sweep can check the process's
 * heartbeat and name it in the failure it records; a row whose worker is still
 * heartbeating is simply a slow build and is filtered out by the caller.
 */
export async function listStalledDeployments(
  staleMs: number,
  limit = 50,
): Promise<DeploymentWithWorkerRow[]> {
  const seconds = Math.floor(staleMs / 1000);
  return selectDeploymentsWithWorker()
    .where('deployments.status', 'in', IN_FLIGHT_DEPLOYMENT_STATUSES)
    // Raw rather than a typed comparison: `updated_at` is Generated<Timestamp>,
    // and Kysely will not compare a generated column against a RawBuilder.
    .where(sql<boolean>`deployments.updated_at < now() - make_interval(secs => ${seconds})`)
    .orderBy('deployments.updated_at', 'asc')
    .limit(limit)
    .execute();
}

/**
 * Puts a failed deployment back in the queue for a manual retry.
 *
 * Conditional on `status = 'failed'`, which makes a double-clicked Retry safe
 * without a lock: the second update matches nothing, the caller gets
 * `undefined`, and the API answers "a retry is already in flight" instead of
 * enqueuing a second run of a deployment that is already building.
 *
 * The outcome columns of the previous attempt are cleared, because leaving
 * them would make the row read as both queued and failed at once — and the
 * *reason* is not lost: it is in `deployment_events`, and, if the budget was
 * spent, in the dead-letter entry. `image_tag` is deliberately kept: for a
 * rollback it is the input, not an output, and for a normal deploy the next
 * attempt overwrites it with its own tag.
 *
 * `max_attempts` is raised to `attempt + freshAttempts`, keeping it what it
 * claims to be: the ceiling on `attempt`. A manual retry is a brand-new BullMQ
 * job and so gets a brand-new automatic budget, and "attempt 4 of 6" has to
 * stay readable rather than becoming "attempt 4 of 3".
 */
export async function requeueForRetry(
  deploymentId: string,
  freshAttempts: number,
): Promise<DeploymentRow | undefined> {
  return getDb()
    .updateTable('deployments')
    .set({
      status: 'queued',
      max_attempts: sql<number>`attempt + ${freshAttempts}`,
      error_code: null,
      error_message: null,
      finished_at: null,
      duration_ms: null,
      container_id: null,
      host_port: null,
      url: null,
      dead_lettered_at: null,
      queued_at: sql`now()`,
    })
    .where('id', '=', deploymentId)
    .where('status', '=', 'failed')
    .returningAll()
    .executeTakeFirst();
}

/**
 * Marks a deployment's job as parked in the dead-letter queue.
 *
 * Recorded in Postgres as well as Redis so the dashboard can show it on the
 * build history without reading the queue, and so it survives a Redis flush —
 * the DLQ entry is the detail, this column is the fact.
 */
export async function markDeadLettered(deploymentId: string): Promise<void> {
  await getDb()
    .updateTable('deployments')
    .set({ dead_lettered_at: sql`now()` })
    .where('id', '=', deploymentId)
    .execute();
}

export async function updateDeployment(
  deploymentId: string,
  patch: DeploymentUpdate,
): Promise<DeploymentRow | undefined> {
  return getDb()
    .updateTable('deployments')
    .set(patch)
    .where('id', '=', deploymentId)
    .returningAll()
    .executeTakeFirst();
}

export async function findDeploymentById(
  deploymentId: string,
): Promise<DeploymentRow | undefined> {
  return getDb()
    .selectFrom('deployments')
    .selectAll()
    .where('id', '=', deploymentId)
    .executeTakeFirst();
}

/**
 * Deployments that should have a container running right now.
 *
 * `live` plus the two stages where one already exists but is not proven yet, so
 * the boot-time orphan sweep does not remove a container another worker is in
 * the middle of health-checking.
 */
export async function listRunningDeployments(): Promise<DeploymentRow[]> {
  return getDb()
    .selectFrom('deployments')
    .selectAll()
    .where('status', 'in', ['creating_container', 'starting', 'health_check', 'live'])
    .where('container_id', 'is not', null)
    .orderBy('created_at', 'desc')
    .execute();
}

/**
 * Live deployments across one org, joined to the project fields the containers
 * view needs — name, port and health path.
 *
 * One query rather than a list plus N project reads: the containers view is
 * polled every couple of seconds while it is open.
 */
export type RunningDeploymentRow = DeploymentRow & {
  project_name: string;
  project_slug: string;
  app_port: number;
  health_path: string;
  active_deployment_id: string | null;
};

export async function listOrgRunningDeployments(orgId: string): Promise<RunningDeploymentRow[]> {
  return getDb()
    .selectFrom('deployments')
    .innerJoin('projects', 'projects.id', 'deployments.project_id')
    .selectAll('deployments')
    .select([
      'projects.name as project_name',
      'projects.slug as project_slug',
      'projects.app_port as app_port',
      'projects.health_path as health_path',
      'projects.active_deployment_id as active_deployment_id',
    ])
    .where('deployments.org_id', '=', orgId)
    .where('deployments.status', 'in', ['creating_container', 'starting', 'health_check', 'live'])
    .orderBy('deployments.created_at', 'desc')
    .execute();
}

/**
 * Deployments of one project that can be rolled back to.
 *
 * The rule is "was serving, and is not now": `stopped` or `rolled_back`, *and*
 * carrying a `live` event in its timeline. Two conditions rather than one,
 * because each answers a different question — the status says it is out of
 * service and therefore a candidate to return to, the `live` event proves it
 * ever worked. A `failed` deployment is deliberately not offered: rolling back
 * to something that never went live is not a rollback.
 *
 * The `live` event is also where `live_at` comes from. `finished_at` would be
 * the obvious column and is the wrong one — it is overwritten when the
 * deployment is retired, so on a stopped row it says when it *stopped*.
 *
 * `artifact_file_id` / `artifact_bytes` are the fallback path: if the image was
 * pruned, the rollback rebuilds from the stored gzip context instead. A
 * candidate with neither an image tag nor an artifact is returned anyway, with
 * both flags false, so the dashboard can explain *why* it cannot be used
 * rather than silently omitting it.
 */
export type RollbackTargetRow = {
  id: string;
  status: DeploymentStatus;
  attempt: number;
  image_tag: string | null;
  source_ref: string | null;
  source_file_id: string | null;
  created_at: Timestamp;
  // `Date`, not `Timestamp`: Kysely unwraps a `ColumnType` reached through a
  // subquery alias but leaves a directly-selected one wrapped. Both are a Date
  // at runtime; the serializer normalises them the same way.
  live_at: Date | null;
  artifact_file_id: string | null;
  artifact_bytes: number | null;
};

export async function listRollbackTargets(
  projectId: string,
  limit: number,
): Promise<RollbackTargetRow[]> {
  return getDb()
    .selectFrom('deployments')
    .select((eb) => [
      'deployments.id',
      'deployments.status',
      'deployments.attempt',
      'deployments.image_tag',
      'deployments.source_ref',
      'deployments.source_file_id',
      'deployments.created_at',
      eb
        .selectFrom('deployment_events')
        .select('deployment_events.created_at')
        .whereRef('deployment_events.deployment_id', '=', 'deployments.id')
        .where('deployment_events.status', '=', 'live')
        .orderBy('deployment_events.id', 'desc')
        .limit(1)
        .as('live_at'),
      eb
        .selectFrom('files')
        .select('files.id')
        .whereRef('files.deployment_id', '=', 'deployments.id')
        .where('files.kind', '=', 'artifact')
        .orderBy('files.created_at', 'desc')
        .limit(1)
        .as('artifact_file_id'),
      eb
        .selectFrom('files')
        .select('files.size_bytes')
        .whereRef('files.deployment_id', '=', 'deployments.id')
        .where('files.kind', '=', 'artifact')
        .orderBy('files.created_at', 'desc')
        .limit(1)
        .as('artifact_bytes'),
    ])
    .where('deployments.project_id', '=', projectId)
    .where('deployments.status', 'in', ['stopped', 'rolled_back'])
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('deployment_events')
          .select('deployment_events.id')
          .whereRef('deployment_events.deployment_id', '=', 'deployments.id')
          .where('deployment_events.status', '=', 'live'),
      ),
    )
    .orderBy('deployments.created_at', 'desc')
    .limit(limit)
    .execute();
}

/**
 * The deployment a project currently points at, if any.
 *
 * Read inside the project lock during the container swap: the row is what says
 * which container is serving, so the *old* one has to be read before the
 * pointer moves, not after.
 */
export async function findActiveDeployment(projectId: string): Promise<DeploymentRow | undefined> {
  return getDb()
    .selectFrom('deployments')
    .innerJoin('projects', 'projects.active_deployment_id', 'deployments.id')
    .selectAll('deployments')
    .where('projects.id', '=', projectId)
    .executeTakeFirst();
}

/**
 * Clears a project's active pointer only if it still names this deployment.
 *
 * Conditional because a stop racing a deploy must not un-point the project from
 * the *new* container: the loser's update matches nothing and does nothing.
 */
export async function clearActiveDeploymentIf(
  projectId: string,
  deploymentId: string,
): Promise<boolean> {
  const result = await getDb()
    .updateTable('projects')
    .set({ active_deployment_id: null })
    .where('id', '=', projectId)
    .where('active_deployment_id', '=', deploymentId)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** Points a project at its currently-serving deployment. */
export async function setActiveDeployment(
  projectId: string,
  deploymentId: string | null,
): Promise<void> {
  await getDb()
    .updateTable('projects')
    .set({ active_deployment_id: deploymentId })
    .where('id', '=', projectId)
    .execute();
}
