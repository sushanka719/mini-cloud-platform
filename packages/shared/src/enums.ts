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
