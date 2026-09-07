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
 *
 * Every in-flight status also lists `queued`, and that edge is Phase 10's: it
 * is what happens when the worker holding the row dies. BullMQ stops seeing
 * the job's lock renewed, returns it to the queue, and whichever worker picks
 * it up next hands the row back to `queued` before claiming it. Modelling that
 * as a legal transition rather than forcing it is deliberate — "went back to
 * the queue because its worker vanished" is a real thing that happens to a
 * deployment, and the dashboard should be able to show it as one.
 */
export const DEPLOYMENT_TRANSITIONS: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
  queued: ['assigned', 'failed', 'canceled'],
  // `assigned → creating_container` is the rollback shortcut (Phase 8): the
  // target's image is already on the host, so there is nothing to clone,
  // install or build. Skipping those stages is the truth, and recording them
  // as instant successes would not be.
  assigned: ['cloning', 'creating_container', 'queued', 'failed', 'canceled'],
  // `cloning → creating_container` is the *other* rollback path: the image was
  // pruned, so the stored artifact is extracted (that is the clone) and the
  // image is rebuilt inside `creating_container`. Install and build still did
  // not run — their output is baked into the artifact.
  cloning: ['installing', 'creating_container', 'queued', 'failed', 'canceled'],
  installing: ['building', 'queued', 'failed', 'canceled'],
  building: ['creating_container', 'queued', 'failed', 'canceled'],
  creating_container: ['starting', 'queued', 'failed', 'canceled'],
  starting: ['health_check', 'queued', 'failed', 'canceled'],
  health_check: ['live', 'queued', 'failed', 'canceled'],
  live: ['stopped', 'rolled_back', 'failed'],
  // A retry re-queues the same deployment row; attempts are tracked on it.
  failed: ['queued'],
  stopped: ['queued'],
  rolled_back: [],
  canceled: [],
};

/**
 * Stages a rollback legitimately skips, by how it got its image.
 *
 * The dashboard renders these greyed rather than pending, so a rollback that
 * jumped from `assigned` to `creating_container` does not look like a pipeline
 * that lost three stages.
 */
export const ROLLBACK_SKIPPED_STAGES = {
  image: ['cloning', 'installing', 'building'],
  artifact: ['installing', 'building'],
} as const satisfies Record<string, readonly DeploymentStatus[]>;

export type RollbackSource = keyof typeof ROLLBACK_SKIPPED_STAGES;

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
  /** How many times this row has been *run*; incremented on every claim. */
  attempt: z.number().int().nonnegative(),
  /**
   * The retry budget in force when the row was created, recorded on it so the
   * history stays self-describing after `DEPLOY_JOB_ATTEMPTS` is changed —
   * "attempt 2 of 3" has to mean the 3 that applied at the time.
   */
  maxAttempts: z.number().int().positive(),
  /** Set when the retry budget was spent and the job was parked in the DLQ. */
  deadLetteredAt: z.string().nullable(),
  triggeredBy: z.string().uuid().nullable(),
  workerId: z.string().uuid().nullable(),
  /**
   * The registry name of that worker (`<host>-<pid>` unless WORKER_NAME says
   * otherwise), joined in so the build history can answer "which worker ran
   * this?" without a second request per row. Null when no worker has claimed
   * the row yet, or when its registry row has since been pruned — the FK is
   * ON DELETE SET NULL, so the id can outlive nothing but itself.
   */
  workerName: z.string().nullable(),
  /** The deployment this one rolls back to, when it is a rollback. */
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
   * Demo hook: make the pipeline fail on entering this stage. It fires *after*
   * the transition is recorded, so the timeline still shows how far it got.
   * Kept for the real pipeline (Phase 6) as well — a healthy sample app cannot
   * fail a health check on demand, and Phase 11's demos need it to.
   */
  failAt: deploymentStatusSchema.optional(),
});
export type CreateDeploymentInput = z.infer<typeof createDeploymentSchema>;

/**
 * Rolling back: create a new deployment from a *previous* one's image.
 *
 * A new row rather than a mutation of the old one, because a rollback is a
 * deployment — it has its own attempt, its own container, its own timeline —
 * and because the row it came from has to survive as the thing it points at
 * (`parentDeploymentId`). The target is named in the URL, so the body only
 * carries the duplicate-click guard.
 */
export const createRollbackSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});
export type CreateRollbackInput = z.infer<typeof createRollbackSchema>;

/**
 * A deployment that can be rolled back to.
 *
 * "Was serving and isn't now" — `stopped` or `rolled_back` — which is exactly
 * the set that has been proven to work. A `failed` deployment is deliberately
 * not offered: rolling back to something that never went live is not a
 * rollback. `hasImage` / `hasArtifact` say which of the two paths a rollback
 * would take, and a candidate with neither cannot be rolled back to at all.
 */
export const rollbackTargetSchema = z.object({
  deploymentId: z.string().uuid(),
  status: deploymentStatusSchema,
  attempt: z.number().int().nonnegative(),
  imageTag: z.string().nullable(),
  sourceRef: z.string().nullable(),
  /** True when the tag is recorded; the image may still have been pruned. */
  hasImage: z.boolean(),
  /** True when the gzipped build context is still in the object store. */
  hasArtifact: z.boolean(),
  artifactBytes: z.number().int().nullable(),
  liveAt: z.string().nullable(),
  createdAt: z.string(),
});
export type RollbackTarget = z.infer<typeof rollbackTargetSchema>;

/**
 * The answer to a retry request.
 *
 * `enqueued: false` is a real outcome, not an error — the same shape stop and
 * restart use. Retrying a deployment that is already running has already got
 * what it asked for, and a 409 would make a double-click look like a failure.
 */
export const retryResultSchema = z.object({
  deploymentId: z.string().uuid(),
  enqueued: z.boolean(),
  /** The attempt the re-queued run will be recorded as. */
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  message: z.string(),
});
export type RetryResult = z.infer<typeof retryResultSchema>;

// --- Dead letters -----------------------------------------------------------

/**
 * What is parked in the `deployments-dlq` queue when a deployment's retry
 * budget is spent.
 *
 * A copy of the reason rather than a pointer, deliberately: the DLQ's whole
 * job is to still be readable when the thing it describes has moved on, and
 * `deployments.error_code` is overwritten by the next attempt.
 */
export const deadLetterJobSchema = z.object({
  deploymentId: z.string().uuid(),
  projectId: z.string().uuid(),
  orgId: z.string().uuid(),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  errorCode: z.string(),
  errorMessage: z.string(),
  /** False when the failure was unrecoverable and no retry was attempted. */
  retryable: z.boolean(),
  failedAt: z.string(),
  workerName: z.string().nullable(),
});
export type DeadLetterJob = z.infer<typeof deadLetterJobSchema>;

/** One parked entry, as the API serves it. `jobId` is what discards it. */
export const deadLetterEntrySchema = deadLetterJobSchema.extend({
  jobId: z.string(),
  /** The deployment's status *now* — a retried, then-live row says `live`. */
  currentStatus: deploymentStatusSchema.nullable(),
  projectName: z.string().nullable(),
});
export type DeadLetterEntry = z.infer<typeof deadLetterEntrySchema>;

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

/**
 * The failure code for "the worker running this deployment disappeared"
 * (Phase 10).
 *
 * It lives here rather than in the worker because three places have to agree
 * on it: the sweep that writes it, the processor that treats a row carrying it
 * as re-runnable rather than finished, and the dashboard, which explains it
 * differently from a build failure — nothing was wrong with the build.
 */
export const WORKER_LOST_CODE = 'WORKER_LOST';

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

/**
 * One API replica, as seen from any other one (Phase 10).
 *
 * There is no registry table for API processes and there should not be: an API
 * replica is stateless, holds nothing authoritative, and is only interesting
 * while it is running. Its liveness signal is therefore the same one workers
 * and container samples use — a Redis document under a TTL, written by the
 * process itself (Phase 9's `metrics:process:api:<instance>`). A replica that
 * is SIGKILLed drops off this list when its key expires; nothing reaps it.
 *
 * This is a projection of `ProcessMetrics`, not a new measurement: the fleet
 * page wants "who is up, how loaded, how many sockets", and re-deriving that
 * from a metrics document beats writing a second heartbeat that could disagree
 * with the first.
 */
export const apiReplicaSchema = z.object({
  /** `API_INSTANCE_ID`, defaulting to `<host>-<pid>`. The identity. */
  instance: z.string(),
  host: z.string(),
  pid: z.number().int(),
  uptimeMs: z.number().nonnegative(),
  /** Percent of one core over the reporting interval. */
  cpuPercent: z.number().nonnegative(),
  rssBytes: z.number().int().nonnegative(),
  /** Open WebSockets on this replica — the number a round-robin proxy moves. */
  sockets: z.number().int().nonnegative(),
  requestsPerSecond: z.number().nonnegative(),
  inflight: z.number().int().nonnegative(),
  /** When this replica last wrote its document. */
  at: z.string(),
});
export type ApiReplicaView = z.infer<typeof apiReplicaSchema>;

export const fleetSchema = z.object({
  queue: queueStatsSchema,
  /**
   * Added in Phase 8. Additive on purpose: the only consumer is our own
   * dashboard, and a fleet view that shows the retry budget being spent but not
   * where the exhausted jobs went would be telling half the story.
   */
  deadLetter: queueStatsSchema,
  containerActions: queueStatsSchema,
  workers: z.array(workerSchema),
  /**
   * Added in Phase 10, same additive rule. A fleet view that showed the
   * workers competing for the queue but not the API replicas fanning out the
   * results would describe half the horizontal story.
   */
  api: z.array(apiReplicaSchema),
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
