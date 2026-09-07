export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * Thin fetch wrapper. Two things matter here:
 *  - `credentials: 'include'` — the session lives in an httpOnly cookie on a
 *    different origin (:4000), so it is only sent when we ask for it.
 *  - errors are turned into `ApiError` carrying the API's own code/message, so
 *    a component can render "You do not have the admin role" rather than
 *    "Request failed".
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthorized() {
    return this.status === 401;
  }
  get isForbidden() {
    return this.status === 403;
  }
}

type ErrorBody = { error?: { code?: string; message?: string; details?: unknown } };

async function toApiError(res: Response): Promise<ApiError> {
  let body: ErrorBody = {};
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    // Non-JSON error (proxy, crash) — fall through to the status text.
  }
  return new ApiError(
    res.status,
    body.error?.code ?? 'UNKNOWN',
    body.error?.message ?? res.statusText ?? 'Request failed',
    body.error?.details,
  );
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    cache: 'no-store',
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { 'content-type': 'application/json' }
        : {}),
      ...init.headers,
    },
  });

  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, form: FormData) =>
    apiFetch<T>(path, { method: 'POST', body: form }),
};

// --- types mirrored from @forge/shared ---------------------------------------
// The dashboard may only depend on `shared` (ARCHITECTURE §9) and is bundled by
// Next, not tsc, so these are kept as plain structural types.

export type OrgRole = 'viewer' | 'member' | 'admin' | 'owner';

export const ROLE_RANK: Record<OrgRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** Mirrors the server-side check so the UI hides what the API would refuse. */
export function hasRole(role: OrgRole | undefined, required: OrgRole): boolean {
  return role !== undefined && ROLE_RANK[role] >= ROLE_RANK[required];
}

export type DependencyHealth = { ok: boolean; latencyMs: number; error?: string };

export type HealthResponse = {
  ok: boolean;
  service: string;
  version: string;
  uptimeMs: number;
  checks: { postgres: DependencyHealth; redis: DependencyHealth };
};

export type PublicUser = { id: string; email: string; name: string; createdAt: string };

export type OrgMembership = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  role: OrgRole;
};

export type SessionResponse = {
  user: PublicUser;
  orgs: OrgMembership[];
  via: 'session' | 'api_key';
};

export type AuthResponse = {
  user: PublicUser;
  orgs: OrgMembership[];
  token: string;
  expiresAt: string;
};

export type OrgMemberView = {
  userId: string;
  email: string;
  name: string;
  role: OrgRole;
  joinedAt: string;
};

export type ApiKeyView = {
  id: string;
  name: string;
  prefix: string;
  role: OrgRole;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type CreatedApiKey = ApiKeyView & { key: string };

export type Project = {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  sourceType: 'upload' | 'git';
  repoUrl: string | null;
  rootDir: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  appPort: number;
  healthPath: string;
  healthTimeoutMs: number;
  activeDeploymentId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type EnvVar = {
  id: string;
  projectId: string;
  key: string;
  isSecret: boolean;
  value: string | null;
  valueLength: number;
  createdAt: string;
  updatedAt: string;
};

export type FileKind = 'source' | 'artifact' | 'log';

export type StoredFile = {
  id: string;
  projectId: string | null;
  deploymentId: string | null;
  kind: FileKind;
  storagePath: string;
  sizeBytes: number;
  checksum: string | null;
  contentType: string | null;
  originalName: string | null;
  parentFileId: string | null;
  compression: 'gzip' | null;
  uncompressedBytes: number | null;
  uncompressedChecksum: string | null;
  createdAt: string;
};

export type ArtifactResult = {
  file: StoredFile;
  ratio: number;
  durationMs: number;
  threadId: number;
};

export type StorageUsage = {
  objectCount: number;
  totalBytes: number;
  byKind: Record<string, { objectCount: number; totalBytes: number }>;
  orphanCount: number;
  orphanBytes: number;
  missingCount: number;
  compression: { threads: number; busy: number; queued: number; poolSize: number };
};

export type DeploymentStatus =
  | 'queued'
  | 'assigned'
  | 'cloning'
  | 'installing'
  | 'building'
  | 'creating_container'
  | 'starting'
  | 'health_check'
  | 'live'
  | 'failed'
  | 'stopped'
  | 'rolled_back'
  | 'canceled';

/** The happy path, in order — mirrors DEPLOYMENT_PIPELINE_STAGES in @forge/shared. */
export const PIPELINE_STAGES: DeploymentStatus[] = [
  'queued',
  'assigned',
  'cloning',
  'installing',
  'building',
  'creating_container',
  'starting',
  'health_check',
  'live',
];

export const STATUS_LABELS: Record<DeploymentStatus, string> = {
  queued: 'Queued',
  assigned: 'Worker assigned',
  cloning: 'Cloning source',
  installing: 'Installing',
  building: 'Building',
  creating_container: 'Creating container',
  starting: 'Starting',
  health_check: 'Health check',
  live: 'Live',
  failed: 'Failed',
  stopped: 'Stopped',
  rolled_back: 'Rolled back',
  canceled: 'Canceled',
};

export const TERMINAL_STATUSES: DeploymentStatus[] = [
  'live',
  'failed',
  'stopped',
  'rolled_back',
  'canceled',
];

export function isSettled(status: DeploymentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export type Deployment = {
  id: string;
  projectId: string;
  orgId: string;
  status: DeploymentStatus;
  sourceRef: string | null;
  sourceFileId: string | null;
  idempotencyKey: string | null;
  attempt: number;
  triggeredBy: string | null;
  workerId: string | null;
  parentDeploymentId: string | null;
  imageTag: string | null;
  containerId: string | null;
  url: string | null;
  hostPort: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
};

export type DeploymentEvent = {
  id: number;
  deploymentId: string;
  type: 'status' | 'log';
  status: DeploymentStatus | null;
  stream: 'stdout' | 'stderr' | 'system' | null;
  message: string | null;
  createdAt: string;
};

export type WorkerView = {
  id: string;
  name: string;
  status: 'idle' | 'busy' | 'offline' | 'draining';
  host: string | null;
  pid: number | null;
  currentDeploymentId: string | null;
  concurrency: number;
  lastHeartbeatAt: string | null;
  createdAt: string;
  online: boolean;
};

export type QueueStats = {
  name: string;
  /** False when the counters could not be read at all (Redis unreachable). */
  available: boolean;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
};

export type Fleet = { queue: QueueStats; workers: WorkerView[] };

/** Durations, for deployment timings. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/** "3s ago" / "4m ago" — relative, so a polling list feels live. */
export function formatAgo(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  if (delta < 1000) return 'just now';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Downloads are a plain top-level navigation rather than a fetch: the session
 * cookie is SameSite=Lax, so it rides along on a GET navigation, and the API's
 * `content-disposition: attachment` makes the browser stream it to disk without
 * ever holding the bytes in JS memory.
 */
export function downloadUrl(
  orgSlug: string,
  projectId: string,
  fileId: string,
  options: { decompress?: boolean } = {},
): string {
  const query = options.decompress ? '?decompress=true' : '';
  return `${API_URL}/orgs/${orgSlug}/projects/${projectId}/files/${fileId}/download${query}`;
}

/** Byte sizes, for every panel that shows one. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export async function fetchHealth(): Promise<HealthResponse> {
  // /health answers 503 with the full body when a dependency is down — that is
  // the state we want to render, so a 503 is not an error here.
  const res = await fetch(`${API_URL}/health`, { cache: 'no-store' });
  const body: unknown = await res.json();
  if (!res.ok && res.status !== 503) throw new Error(`API responded ${res.status}`);
  return body as HealthResponse;
}
