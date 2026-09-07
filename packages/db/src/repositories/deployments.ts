import { sql } from 'kysely';
import { getDb } from '../client.js';
import type { DeploymentEventRow, DeploymentRow, DeploymentUpdate } from '../types.js';
import type { DeploymentStatus, LogStream } from '@forge/shared';

/**
 * Deployments and their append-only event timeline.
 *
 * This repository lives in `@forge/db` rather than in `apps/api` because both
 * the API (producer, reader) and the worker (which drives every transition)
 * need it, and ARCHITECTURE §2.4 puts shared repository helpers here. The
 * app-specific repositories stay in their app.
 *
 * Reads are scoped by `project_id` (and, for the org-level views, `org_id`) so
 * a deployment uuid guessed from another tenant resolves to "not found"
 * (DATA_MODEL §5).
 */

export type InsertDeploymentInput = {
  projectId: string;
  orgId: string;
  sourceRef: string | null;
  sourceFileId: string | null;
  idempotencyKey: string | null;
  triggeredBy: string | null;
  failAt: DeploymentStatus | null;
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
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function listDeployments(
  projectId: string,
  options: { limit: number; status?: DeploymentStatus },
): Promise<DeploymentRow[]> {
  let query = getDb().selectFrom('deployments').selectAll().where('project_id', '=', projectId);
  if (options.status) query = query.where('status', '=', options.status);
  return query.orderBy('created_at', 'desc').limit(options.limit).execute();
}

export async function findDeployment(
  projectId: string,
  deploymentId: string,
): Promise<DeploymentRow | undefined> {
  return getDb()
    .selectFrom('deployments')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('id', '=', deploymentId)
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
export async function listOrgDeployments(orgId: string, limit: number): Promise<DeploymentRow[]> {
  return getDb()
    .selectFrom('deployments')
    .selectAll()
    .where('org_id', '=', orgId)
    .orderBy('created_at', 'desc')
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
 */
export async function claimDeployment(
  deploymentId: string,
  workerId: string,
  attempt: number,
): Promise<DeploymentRow | undefined> {
  return getDb()
    .updateTable('deployments')
    .set({
      status: 'assigned',
      worker_id: workerId,
      attempt,
      started_at: sql`now()`,
    })
    .where('id', '=', deploymentId)
    .where('status', 'in', ['queued', 'assigned'])
    .returningAll()
    .executeTakeFirst();
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
