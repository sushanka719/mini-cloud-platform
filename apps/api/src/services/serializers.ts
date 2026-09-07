import type {
  ApiKeyRow,
  DeploymentEventRow,
  DeploymentRow,
  FileRow,
  Organization,
  ProjectRow,
  User,
  WorkerRow,
} from '@forge/db';
import type {
  ApiKeyView,
  Deployment,
  DeploymentEvent,
  OrgMembership,
  Project,
  PublicOrg,
  PublicUser,
  StoredFile,
  WorkerView,
} from '@forge/shared';
import type { OrgWithRole, MemberWithUser } from '../repositories/org-repository.js';

/**
 * DB row → API response. Centralised so a column added to a table can never
 * leak into a response by accident: every field here is listed deliberately,
 * and `password_hash` / `key_hash` / `value_enc` have no mapping at all.
 */

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: iso(user.created_at as unknown as Date),
  };
}

export function toPublicOrg(org: Organization): PublicOrg {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: iso(org.created_at as unknown as Date),
  };
}

export function toOrgMembership(org: OrgWithRole): OrgMembership {
  return { ...toPublicOrg(org), role: org.role };
}

export function toMemberView(member: MemberWithUser) {
  return {
    userId: member.user_id,
    email: member.email,
    name: member.name,
    role: member.role,
    joinedAt: iso(member.created_at as unknown as Date),
  };
}

export function toApiKeyView(row: ApiKeyRow): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    role: row.role,
    scopes: row.scopes,
    lastUsedAt: row.last_used_at ? iso(row.last_used_at as unknown as Date) : null,
    revokedAt: row.revoked_at ? iso(row.revoked_at as unknown as Date) : null,
    createdAt: iso(row.created_at as unknown as Date),
  };
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    slug: row.slug,
    sourceType: row.source_type,
    repoUrl: row.repo_url,
    rootDir: row.root_dir,
    installCommand: row.install_command,
    buildCommand: row.build_command,
    startCommand: row.start_command,
    appPort: row.app_port,
    healthPath: row.health_path,
    healthTimeoutMs: row.health_timeout_ms,
    activeDeploymentId: row.active_deployment_id,
    createdBy: row.created_by,
    createdAt: iso(row.created_at as unknown as Date),
    updatedAt: iso(row.updated_at as unknown as Date),
  };
}

export function toStoredFile(row: FileRow): StoredFile {
  return {
    id: row.id,
    projectId: row.project_id,
    deploymentId: row.deployment_id,
    kind: row.kind,
    storagePath: row.storage_path,
    sizeBytes: Number(row.size_bytes),
    checksum: row.checksum,
    contentType: row.content_type,
    originalName: row.original_name,
    parentFileId: row.parent_file_id,
    compression: row.compression,
    uncompressedBytes: row.uncompressed_bytes === null ? null : Number(row.uncompressed_bytes),
    uncompressedChecksum: row.uncompressed_checksum,
    createdAt: iso(row.created_at as unknown as Date),
  };
}

/**
 * The join is optional so a plain `DeploymentRow` — what the write paths hand
 * back — still serializes. The list reads that feed the dashboard supply
 * `worker_name`; a create/retry response has no reason to make a second query
 * for a name nobody is showing yet.
 */
export function toDeployment(row: DeploymentRow & { worker_name?: string | null }): Deployment {
  return {
    id: row.id,
    projectId: row.project_id,
    orgId: row.org_id,
    status: row.status,
    sourceRef: row.source_ref,
    sourceFileId: row.source_file_id,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    deadLetteredAt: row.dead_lettered_at ? iso(row.dead_lettered_at as unknown as Date) : null,
    triggeredBy: row.triggered_by,
    workerId: row.worker_id,
    workerName: row.worker_name ?? null,
    parentDeploymentId: row.parent_deployment_id,
    imageTag: row.image_tag,
    containerId: row.container_id,
    url: row.url,
    hostPort: row.host_port,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    queuedAt: iso(row.queued_at as unknown as Date),
    startedAt: row.started_at ? iso(row.started_at as unknown as Date) : null,
    finishedAt: row.finished_at ? iso(row.finished_at as unknown as Date) : null,
    durationMs: row.duration_ms,
    createdAt: iso(row.created_at as unknown as Date),
    updatedAt: iso(row.updated_at as unknown as Date),
  };
}

export function toDeploymentEvent(row: DeploymentEventRow): DeploymentEvent {
  return {
    id: Number(row.id),
    deploymentId: row.deployment_id,
    type: row.type,
    status: row.status,
    stream: row.stream,
    message: row.message,
    createdAt: iso(row.created_at as unknown as Date),
  };
}

/**
 * `online` comes from Redis (the heartbeat key's TTL), not from the row: a
 * worker that was SIGKILLed never gets to write `offline`, so the registry row
 * would lie. The TTL cannot.
 */
export function toWorkerView(row: WorkerRow, online: boolean): WorkerView {
  return {
    id: row.id,
    name: row.name,
    // A row claiming to be busy while its heartbeat has expired is stale.
    status: online ? row.status : 'offline',
    host: row.host,
    pid: row.pid,
    currentDeploymentId: online ? row.current_deployment_id : null,
    concurrency: row.concurrency,
    lastHeartbeatAt: row.last_heartbeat_at ? iso(row.last_heartbeat_at as unknown as Date) : null,
    createdAt: iso(row.created_at as unknown as Date),
    online,
  };
}
