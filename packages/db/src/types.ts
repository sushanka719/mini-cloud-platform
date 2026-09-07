import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';
import type {
  DeploymentEventType,
  DeploymentStatus,
  FileCompression,
  FileKind,
  LogStream,
  OrgRole,
  SourceType,
  WorkerStatus,
} from '@forge/shared';

/** Column the DB always writes (default/trigger): read as Date, never inserted/updated by us. */
export type Timestamp = ColumnType<Date, Date | string | undefined, Date | string | undefined>;

export interface UsersTable {
  id: Generated<string>;
  email: string;
  name: string;
  password_hash: string;
  email_verified_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface OrganizationsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  created_by: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface OrgMembersTable {
  org_id: string;
  user_id: string;
  role: Generated<OrgRole>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ApiKeysTable {
  id: Generated<string>;
  org_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  role: Generated<OrgRole>;
  scopes: Generated<string[]>;
  last_used_at: Timestamp | null;
  created_by: string;
  revoked_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface ProjectsTable {
  id: Generated<string>;
  org_id: string;
  name: string;
  slug: string;
  source_type: Generated<SourceType>;
  repo_url: string | null;
  root_dir: Generated<string>;
  install_command: Generated<string>;
  build_command: Generated<string>;
  start_command: Generated<string>;
  app_port: Generated<number>;
  health_path: Generated<string>;
  health_timeout_ms: Generated<number>;
  active_deployment_id: string | null;
  created_by: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ProjectEnvVarsTable {
  id: Generated<string>;
  project_id: string;
  key: string;
  /** AES-256-GCM ciphertext; `pg` maps bytea to Buffer in both directions. */
  value_enc: Buffer;
  value_length: Generated<number>;
  is_secret: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface FilesTable {
  id: Generated<string>;
  project_id: string | null;
  deployment_id: string | null;
  kind: FileKind;
  storage_path: string;
  /** bigint — the int8 parser in client.ts returns it as a JS number. */
  size_bytes: Generated<number>;
  checksum: string | null;
  content_type: string | null;
  original_name: string | null;
  /** The source row a `kind='artifact'` object was derived from. */
  parent_file_id: string | null;
  /** null = stored as-is; 'gzip' = size_bytes/checksum are the compressed bytes. */
  compression: FileCompression | null;
  uncompressed_bytes: number | null;
  uncompressed_checksum: string | null;
  created_at: Generated<Timestamp>;
}

export interface WorkersTable {
  id: Generated<string>;
  name: string;
  status: Generated<WorkerStatus>;
  host: string | null;
  pid: number | null;
  current_deployment_id: string | null;
  concurrency: Generated<number>;
  last_heartbeat_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface DeploymentsTable {
  id: Generated<string>;
  project_id: string;
  org_id: string;
  status: Generated<DeploymentStatus>;
  source_ref: string | null;
  source_file_id: string | null;
  idempotency_key: string | null;
  attempt: Generated<number>;
  triggered_by: string | null;
  worker_id: string | null;
  parent_deployment_id: string | null;
  image_tag: string | null;
  container_id: string | null;
  url: string | null;
  host_port: number | null;
  /** Demo hook: the simulated pipeline fails here. Phase 6 makes it a no-op. */
  fail_at: DeploymentStatus | null;
  error_code: string | null;
  error_message: string | null;
  queued_at: Generated<Timestamp>;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
  duration_ms: number | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface DeploymentEventsTable {
  /** bigint identity — monotonic, so it doubles as the replay cursor. */
  id: Generated<number>;
  deployment_id: string;
  type: DeploymentEventType;
  status: DeploymentStatus | null;
  stream: LogStream | null;
  message: string | null;
  created_at: Generated<Timestamp>;
}

/** The full database schema Kysely is typed against. Extend as migrations land. */
export interface Database {
  users: UsersTable;
  organizations: OrganizationsTable;
  org_members: OrgMembersTable;
  api_keys: ApiKeysTable;
  projects: ProjectsTable;
  project_env_vars: ProjectEnvVarsTable;
  files: FilesTable;
  workers: WorkersTable;
  deployments: DeploymentsTable;
  deployment_events: DeploymentEventsTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;

export type Organization = Selectable<OrganizationsTable>;
export type NewOrganization = Insertable<OrganizationsTable>;
export type OrganizationUpdate = Updateable<OrganizationsTable>;

export type OrgMember = Selectable<OrgMembersTable>;
export type NewOrgMember = Insertable<OrgMembersTable>;
export type OrgMemberUpdate = Updateable<OrgMembersTable>;

export type ApiKeyRow = Selectable<ApiKeysTable>;
export type NewApiKey = Insertable<ApiKeysTable>;
export type ApiKeyUpdate = Updateable<ApiKeysTable>;

export type ProjectRow = Selectable<ProjectsTable>;
export type NewProject = Insertable<ProjectsTable>;
export type ProjectUpdate = Updateable<ProjectsTable>;

export type ProjectEnvVarRow = Selectable<ProjectEnvVarsTable>;
export type NewProjectEnvVar = Insertable<ProjectEnvVarsTable>;
export type ProjectEnvVarUpdate = Updateable<ProjectEnvVarsTable>;

export type FileRow = Selectable<FilesTable>;
export type NewFile = Insertable<FilesTable>;
export type FileUpdate = Updateable<FilesTable>;

export type WorkerRow = Selectable<WorkersTable>;
export type NewWorker = Insertable<WorkersTable>;
export type WorkerUpdate = Updateable<WorkersTable>;

export type DeploymentRow = Selectable<DeploymentsTable>;
export type NewDeployment = Insertable<DeploymentsTable>;
export type DeploymentUpdate = Updateable<DeploymentsTable>;

export type DeploymentEventRow = Selectable<DeploymentEventsTable>;
export type NewDeploymentEvent = Insertable<DeploymentEventsTable>;
