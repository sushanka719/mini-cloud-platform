import { z } from 'zod';

/** Mirrors the `org_role` Postgres enum. Ordered least → most privileged. */
export const ORG_ROLES = ['viewer', 'member', 'admin', 'owner'] as const;
export const orgRoleSchema = z.enum(ORG_ROLES);
export type OrgRole = z.infer<typeof orgRoleSchema>;

/** Numeric rank so `requireRole('admin')` is a comparison, not a set lookup. */
export const ORG_ROLE_RANK: Record<OrgRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

/** Mirrors the `deployment_status` Postgres enum. Canonical pipeline order first. */
export const DEPLOYMENT_STATUSES = [
  'queued',
  'assigned',
  'cloning',
  'installing',
  'building',
  'creating_container',
  'starting',
  'health_check',
  'live',
  'failed',
  'stopped',
  'rolled_back',
  'canceled',
] as const;
export const deploymentStatusSchema = z.enum(DEPLOYMENT_STATUSES);
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;

/** Statuses a deployment can never leave. */
export const TERMINAL_DEPLOYMENT_STATUSES = [
  'failed',
  'stopped',
  'rolled_back',
  'canceled',
] as const satisfies readonly DeploymentStatus[];

export function isTerminalStatus(status: DeploymentStatus): boolean {
  return (TERMINAL_DEPLOYMENT_STATUSES as readonly DeploymentStatus[]).includes(status);
}

/**
 * Statuses in which exactly one worker owns the row and is expected to be
 * moving it along. `queued` is deliberately absent: a queued deployment is
 * owned by the queue, not by a process.
 *
 * This is the set Phase 10's crash recovery reads. If a row sits in one of
 * these and the worker whose id is on it is no longer heartbeating, the row is
 * describing a process that does not exist — and something has to say so,
 * either by taking the job over or by recording the loss.
 */
export const IN_FLIGHT_DEPLOYMENT_STATUSES = [
  'assigned',
  'cloning',
  'installing',
  'building',
  'creating_container',
  'starting',
  'health_check',
] as const satisfies readonly DeploymentStatus[];

export function isInFlightStatus(status: DeploymentStatus): boolean {
  return (IN_FLIGHT_DEPLOYMENT_STATUSES as readonly DeploymentStatus[]).includes(status);
}

export const WORKER_STATUSES = ['idle', 'busy', 'offline', 'draining'] as const;
export const workerStatusSchema = z.enum(WORKER_STATUSES);
export type WorkerStatus = z.infer<typeof workerStatusSchema>;

export const FILE_KINDS = ['source', 'artifact', 'log'] as const;
export const fileKindSchema = z.enum(FILE_KINDS);
export type FileKind = z.infer<typeof fileKindSchema>;

/** How a stored object's bytes are encoded on disk. null = stored as-is. */
export const FILE_COMPRESSIONS = ['gzip'] as const;
export const fileCompressionSchema = z.enum(FILE_COMPRESSIONS);
export type FileCompression = z.infer<typeof fileCompressionSchema>;

export const LOG_STREAMS = ['stdout', 'stderr', 'system'] as const;
export const logStreamSchema = z.enum(LOG_STREAMS);
export type LogStream = z.infer<typeof logStreamSchema>;
