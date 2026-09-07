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

/**
 * Which API replica served the most recent request, from the proxy's
 * `x-forge-upstream` response header (Phase 10).
 *
 * A module-level box rather than state threaded through every call: it is a
 * diagnostic about the *transport*, wanted by exactly one panel, and plumbing
 * it through `api.get` would change the shape of every call site for it. The
 * value is `null` whenever the dashboard is talking straight to a replica —
 * there is no proxy to name one.
 *
 * Subscribers exist because the header changes on every request (that is the
 * point of round-robin) and React has no way to notice a mutated module
 * variable.
 */
let lastUpstream: string | null = null;
const upstreamListeners = new Set<(upstream: string | null) => void>();

export function getLastUpstream(): string | null {
  return lastUpstream;
}

export function onUpstreamChange(listener: (upstream: string | null) => void): () => void {
  upstreamListeners.add(listener);
  return () => upstreamListeners.delete(listener);
}

function recordUpstream(res: Response): void {
  const upstream = res.headers.get('x-forge-upstream');
  // Only a *present* header updates the box. A response that omits it (an
  // error page the proxy wrote itself, a request that never reached a replica)
  // must not be read as "the proxy disappeared".
  if (!upstream || upstream === lastUpstream) return;
  lastUpstream = upstream;
  for (const listener of upstreamListeners) listener(upstream);
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

  recordUpstream(res);

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
  /** Runs of this row so far; incremented on every claim. */
  attempt: number;
  /** The ceiling on `attempt` for the currently queued job. */
  maxAttempts: number;
  /** Set when the retry budget ran out and the job was parked in the DLQ. */
  deadLetteredAt: string | null;
  triggeredBy: string | null;
  workerId: string | null;
  /** The worker's registry name, joined server-side (Phase 10). */
  workerName: string | null;
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

export type ContainerStats = {
  deploymentId: string;
  containerId: string;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  pids: number;
  pidsLimit: number;
  state: string;
  at: string;
};

export type ContainerSummary = {
  deploymentId: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  orgId: string;
  status: DeploymentStatus;
  containerId: string | null;
  imageTag: string | null;
  url: string | null;
  hostPort: number | null;
  appPort: number;
  healthPath: string;
  attempt: number;
  startedAt: string | null;
  liveSince: string | null;
  isActive: boolean;
  /** null when no worker has sampled this container recently. */
  stats: ContainerStats | null;
};

export type ContainerActionResult = {
  action: 'stop' | 'restart';
  deploymentId: string;
  enqueued: boolean;
  message: string;
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

/**
 * One API replica (Phase 10). Projected server-side out of the process-metrics
 * document each replica writes to Redis under a TTL — so this list is exactly
 * "the replicas that are reporting right now", and a killed one drops off on
 * its own.
 */
export type ApiReplica = {
  instance: string;
  host: string;
  pid: number;
  uptimeMs: number;
  cpuPercent: number;
  rssBytes: number;
  sockets: number;
  requestsPerSecond: number;
  inflight: number;
  at: string;
};

export type Fleet = {
  queue: QueueStats;
  deadLetter: QueueStats;
  containerActions: QueueStats;
  workers: WorkerView[];
  api: ApiReplica[];
};

/**
 * `GET /__forge/proxy` — served by the reverse proxy itself, not by the API.
 *
 * Only reachable when the dashboard is pointed at the proxy, which is why the
 * fleet page treats a failed fetch as "no proxy in front of us" rather than as
 * an error: talking straight to one replica is a perfectly valid setup.
 */
export type ProxyStatus = {
  ok: boolean;
  port: number;
  uptimeMs: number;
  healthPath: string;
  upstreams: {
    target: string;
    healthy: boolean;
    requests: number;
    upgrades: number;
    connectErrors: number;
    lastProbeMs: number | null;
    lastError: string | null;
  }[];
  healthy: number;
  total: number;
  requests: number;
  upgrades: number;
  at: string;
};

export const PROXY_STATUS_PATH = '/__forge/proxy';

// --- observability (Phase 9) -------------------------------------------------

export type ProcessRole = 'api' | 'worker';

/** Mirrors `eventLoopLagSchema` — reset every reporting interval. */
export type EventLoopLag = { meanMs: number; p50Ms: number; p99Ms: number; maxMs: number };

export type ApiRuntimeMetrics = {
  sockets: number;
  topics: number;
  pubsubChannels: number;
  pubsubConnected: boolean;
  requests: number;
  requestsPerSecond: number;
  inflight: number;
  serverErrors: number;
  clientErrors: number;
  latencyMs: { p50: number; p95: number; max: number };
};

export type WorkerRuntimeMetrics = {
  workerId: string | null;
  status: string;
  activeJobs: number;
  concurrency: number;
  activeBuilds: number;
  dockerAvailable: boolean;
};

/** Mirrors `processMetricsSchema` — one live process, read from Redis. */
export type ProcessMetrics = {
  role: ProcessRole;
  instance: string;
  pid: number;
  host: string;
  nodeVersion: string;
  uptimeMs: number;
  sampledOverMs: number;
  cpuPercent: number;
  userCpuPercent: number;
  systemCpuPercent: number;
  eventLoopUtilization: number;
  eventLoopLag: EventLoopLag;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  activeResources: number;
  api: ApiRuntimeMetrics | null;
  worker: WorkerRuntimeMetrics | null;
  at: string;
};

/** null rather than 0 when nothing was measured — see `durationStatsSchema`. */
export type DurationStats = {
  count: number;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
};

export type FailureBucket = { code: string; count: number };

export type DeploymentMetrics = {
  windowMinutes: number;
  total: number;
  byStatus: Partial<Record<DeploymentStatus, number>>;
  succeeded: number;
  failed: number;
  retried: number;
  deadLettered: number;
  inFlight: number;
  /** null when nothing settled in the window. */
  successRate: number | null;
  duration: DurationStats;
  failuresByCode: FailureBucket[];
};

/** Mirrors `metricsSnapshotSchema` — one consistent read of the whole system. */
export type MetricsSnapshot = {
  at: string;
  servedBy: string;
  processes: ProcessMetrics[];
  queues: QueueStats[];
  deployments: DeploymentMetrics;
  containers: ContainerStats[];
  dependencies: {
    postgres: { ok: boolean; latencyMs: number };
    redis: { ok: boolean; latencyMs: number };
  };
};

/** Mirrors `retryResultSchema`. `enqueued: false` means "nothing to do". */
export type RetryResult = {
  deploymentId: string;
  enqueued: boolean;
  attempt: number;
  maxAttempts: number;
  message: string;
};

/** Mirrors `rollbackTargetSchema` — a deployment that can be returned to. */
export type RollbackTarget = {
  deploymentId: string;
  status: DeploymentStatus;
  attempt: number;
  imageTag: string | null;
  sourceRef: string | null;
  /** The tag is recorded; the image itself may since have been pruned. */
  hasImage: boolean;
  hasArtifact: boolean;
  artifactBytes: number | null;
  liveAt: string | null;
  createdAt: string;
};

/** Mirrors `deadLetterEntrySchema` — one exhausted deployment, parked. */
export type DeadLetterEntry = {
  jobId: string;
  deploymentId: string;
  projectId: string;
  orgId: string;
  attempt: number;
  maxAttempts: number;
  errorCode: string;
  errorMessage: string;
  /** False when the failure was unrecoverable and no retry was attempted. */
  retryable: boolean;
  failedAt: string;
  workerName: string | null;
  /** The deployment's status *now* — often no longer `failed`. */
  currentStatus: DeploymentStatus | null;
  projectName: string | null;
};

/**
 * Stages a rollback legitimately skips, by where its image came from.
 * Mirrors `ROLLBACK_SKIPPED_STAGES` in @forge/shared.
 */
export const ROLLBACK_SKIPPED_STAGES: Record<'image' | 'artifact', DeploymentStatus[]> = {
  image: ['cloning', 'installing', 'building'],
  artifact: ['installing', 'building'],
};

/** Durations, for deployment timings. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/** "4m 12s" / "3h 05m" — for uptimes, where formatDuration's ms are noise. */
export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
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

/** Percentages from the container stats: one decimal, never "NaN%". */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

export async function fetchHealth(): Promise<HealthResponse> {
  // /health answers 503 with the full body when a dependency is down — that is
  // the state we want to render, so a 503 is not an error here.
  const res = await fetch(`${API_URL}/health`, { cache: 'no-store' });
  const body: unknown = await res.json();
  if (!res.ok && res.status !== 503) throw new Error(`API responded ${res.status}`);
  return body as HealthResponse;
}
