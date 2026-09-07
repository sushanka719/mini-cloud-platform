import { z } from 'zod';
import { deploymentStatusSchema, logStreamSchema, workerStatusSchema } from './enums.js';
import type { DeploymentStatus } from './enums.js';

/**
 * The deployment state machine, written once and shared by the API (which
 * validates user-triggered transitions) and the worker (which drives the
 * pipeline). ARCHITECTURE §4 is the picture; this is the executable version.
 *
 * A transition that isn't listed here is a bug, not a user error — the worker
 * throws on one rather than writing an impossible row.
 */
export const DEPLOYMENT_TRANSITIONS: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
  queued: ['assigned', 'failed', 'canceled'],
  assigned: ['cloning', 'failed', 'canceled'],
  cloning: ['installing', 'failed', 'canceled'],
  installing: ['building', 'failed', 'canceled'],
  building: ['creating_container', 'failed', 'canceled'],
  creating_container: ['starting', 'failed', 'canceled'],
  starting: ['health_check', 'failed', 'canceled'],
  health_check: ['live', 'failed', 'canceled'],
  live: ['stopped', 'rolled_back', 'failed'],
  // A retry re-queues the same deployment row; attempts are tracked on it.
  failed: ['queued'],
  stopped: ['queued'],
  rolled_back: [],
  canceled: [],
};

export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return DEPLOYMENT_TRANSITIONS[from].includes(to);
}

/**
 * The happy path, in order — what the dashboard renders as a progress bar.
 * Terminal/branch statuses (`failed`, `stopped`, …) are deliberately absent.
 */
export const DEPLOYMENT_PIPELINE_STAGES = [
  'queued',
  'assigned',
  'cloning',
  'installing',
  'building',
  'creating_container',
  'starting',
  'health_check',
  'live',
] as const satisfies readonly DeploymentStatus[];

export type DeploymentPipelineStage = (typeof DEPLOYMENT_PIPELINE_STAGES)[number];

/** Human labels for the pipeline animation; one place so API/UI agree. */
export const DEPLOYMENT_STATUS_LABELS: Record<DeploymentStatus, string> = {
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

/** How far through the happy path a status is; -1 for off-path statuses. */
export function pipelineStageIndex(status: DeploymentStatus): number {
  return (DEPLOYMENT_PIPELINE_STAGES as readonly DeploymentStatus[]).indexOf(status);
}

// --- API shapes -------------------------------------------------------------

export const deploymentSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  orgId: z.string().uuid(),
  status: deploymentStatusSchema,
  /** What was deployed: the source `files.id` for uploads, a ref for git. */
  sourceRef: z.string().nullable(),
  sourceFileId: z.string().uuid().nullable(),
  idempotencyKey: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  triggeredBy: z.string().uuid().nullable(),
  workerId: z.string().uuid().nullable(),
  parentDeploymentId: z.string().uuid().nullable(),
  imageTag: z.string().nullable(),
  containerId: z.string().nullable(),
  url: z.string().nullable(),
  hostPort: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Deployment = z.infer<typeof deploymentSchema>;

/**
 * `idempotencyKey` is the client's promise that two requests carrying it mean
 * one deployment. A duplicate returns the existing row (200) instead of
 * creating a second one (202) — see CLAUDE.md §7.
 */
export const createDeploymentSchema = z.object({
  /** Defaults to the newest uploaded source for the project. */
  sourceFileId: z.string().uuid().optional(),
  /** For git projects; ignored for uploads, where the file id is the ref. */
  sourceRef: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
  /**
   * Demo hook: make the simulated pipeline fail at this stage. Phase 6 replaces
   * the simulation with a real build, and this becomes a no-op there.
   */
  failAt: deploymentStatusSchema.optional(),
});
export type CreateDeploymentInput = z.infer<typeof createDeploymentSchema>;

export const deploymentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: deploymentStatusSchema.optional(),
});
export type DeploymentListQuery = z.infer<typeof deploymentListQuerySchema>;

export const DEPLOYMENT_EVENT_TYPES = ['status', 'log'] as const;
export const deploymentEventTypeSchema = z.enum(DEPLOYMENT_EVENT_TYPES);
export type DeploymentEventType = z.infer<typeof deploymentEventTypeSchema>;

/** Append-only timeline row. `id` is monotonic, so it doubles as a cursor. */
export const deploymentEventSchema = z.object({
  id: z.number().int(),
  deploymentId: z.string().uuid(),
  type: deploymentEventTypeSchema,
  status: deploymentStatusSchema.nullable(),
  stream: logStreamSchema.nullable(),
  message: z.string().nullable(),
  createdAt: z.string(),
});
export type DeploymentEvent = z.infer<typeof deploymentEventSchema>;

export const deploymentEventsQuerySchema = z.object({
  /** Return events with id greater than this — the reconnect-replay cursor. */
  afterId: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type DeploymentEventsQuery = z.infer<typeof deploymentEventsQuerySchema>;

// --- Worker fleet -----------------------------------------------------------

export const workerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: workerStatusSchema,
  host: z.string().nullable(),
  pid: z.number().int().nullable(),
  currentDeploymentId: z.string().uuid().nullable(),
  concurrency: z.number().int().positive(),
  lastHeartbeatAt: z.string().nullable(),
  createdAt: z.string(),
  /** True when Redis still holds the worker's heartbeat key (TTL not expired). */
  online: z.boolean(),
});
export type WorkerView = z.infer<typeof workerSchema>;

/** What a worker writes into its Redis heartbeat key. */
export const workerHeartbeatSchema = z.object({
  workerId: z.string().uuid(),
  name: z.string(),
  status: workerStatusSchema,
  host: z.string(),
  pid: z.number().int(),
  concurrency: z.number().int().positive(),
  activeJobs: z.number().int().nonnegative(),
  at: z.string(),
});
export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;

export const queueStatsSchema = z.object({
  name: z.string(),
  /**
   * False when the counters could not be read at all (Redis unreachable). A
   * genuinely paused queue and an unreachable one are different states and
   * must not share a flag.
   */
  available: z.boolean(),
  waiting: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  delayed: z.number().int().nonnegative(),
  paused: z.boolean(),
});
export type QueueStats = z.infer<typeof queueStatsSchema>;

export const fleetSchema = z.object({
  queue: queueStatsSchema,
  workers: z.array(workerSchema),
});
export type Fleet = z.infer<typeof fleetSchema>;

// --- Queue job payload ------------------------------------------------------

/**
 * The job body BullMQ carries. Deliberately small: it is a pointer into
 * Postgres, not a copy of the deployment. The worker re-reads the row, so a
 * job that sat in the queue while the project changed still builds what the
 * database says (CLAUDE.md §4, multi-process shared state).
 */
export const deploymentJobSchema = z.object({
  deploymentId: z.string().uuid(),
  projectId: z.string().uuid(),
  orgId: z.string().uuid(),
  /** Mirrored for log context only; the row is still the source of truth. */
  sourceFileId: z.string().uuid().nullable(),
  triggeredBy: z.string().uuid().nullable(),
  failAt: deploymentStatusSchema.nullable(),
});
export type DeploymentJob = z.infer<typeof deploymentJobSchema>;

/**
 * Frames published on `deployment:<id>`, `project:<id>` and `org:<id>`.
 *
 * Two kinds, discriminated on `type`, mirroring the two kinds of
 * `deployment_events` row. A subscriber must be able to tell a transition from
 * a log line without re-reading the database, so they are distinct shapes
 * rather than one shape with optional fields.
 */
export const deploymentStatusMessageSchema = z.object({
  type: z.literal('status'),
  deploymentId: z.string().uuid(),
  projectId: z.string().uuid(),
  /** Carried so the frame can be routed/authorized without a database read. */
  orgId: z.string().uuid(),
  status: deploymentStatusSchema,
  eventId: z.number().int(),
  message: z.string().nullable(),
  at: z.string(),
});
export type DeploymentStatusMessage = z.infer<typeof deploymentStatusMessageSchema>;

export const deploymentLogMessageSchema = z.object({
  type: z.literal('log'),
  deploymentId: z.string().uuid(),
  projectId: z.string().uuid(),
  orgId: z.string().uuid(),
  /** The status the deployment was in when the line was produced. */
  status: deploymentStatusSchema,
  stream: logStreamSchema,
  eventId: z.number().int(),
  message: z.string(),
  at: z.string(),
});
export type DeploymentLogMessage = z.infer<typeof deploymentLogMessageSchema>;

export const deploymentMessageSchema = z.discriminatedUnion('type', [
  deploymentStatusMessageSchema,
  deploymentLogMessageSchema,
]);
export type DeploymentMessage = z.infer<typeof deploymentMessageSchema>;

/**
 * Hard cap on a single persisted/published log line. Build output is untrusted
 * (CLAUDE.md §8: "sanitize/limit log output size") and one runaway line must
 * not be able to bloat a Postgres row or a WebSocket frame.
 */
export const MAX_LOG_LINE_LENGTH = 4_096;

/** Truncates a log line to `MAX_LOG_LINE_LENGTH`, marking that it was cut. */
export function clampLogLine(line: string): string {
  if (line.length <= MAX_LOG_LINE_LENGTH) return line;
  return `${line.slice(0, MAX_LOG_LINE_LENGTH)}… [truncated ${line.length - MAX_LOG_LINE_LENGTH} chars]`;
}
