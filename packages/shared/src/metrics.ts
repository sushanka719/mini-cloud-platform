import { z } from 'zod';
import { containerStatsSchema } from './containers.js';
import { queueStatsSchema } from './deployments.js';

/**
 * The observability contract (Phase 9).
 *
 * ARCHITECTURE §6 lists what we measure; this is the executable version of it.
 * Three shapes, because they have three different lifetimes:
 *
 *  - **`ProcessMetrics`** — one document per live process, written to Redis
 *    under a TTL by the process itself. Ephemeral by nature, and *shared*: any
 *    API replica renders the whole fleet from Redis rather than from its own
 *    memory, which is the same rule sessions and container samples follow
 *    (CLAUDE.md §4). A process that stops reporting disappears when its key
 *    expires — it cannot lie about being alive.
 *  - **`DeploymentMetrics`** — aggregates over `deployments`, computed in
 *    Postgres on read. Nothing new is written for these: `duration_ms`,
 *    `attempt`, `dead_lettered_at` and `error_code` are already on every row,
 *    so the charts are a query, not a second write path.
 *  - **`MetricMessage`** (in `realtime.ts`) — one sampled number on the wire.
 *    Deliberately flat and tiny: the `metrics` topic ticks a few times a
 *    second and a frame carrying a whole document would be mostly repetition.
 *
 * Nothing here imports `node:perf_hooks`. The *measuring* lives in
 * `@forge/metrics` (node-only); this package stays a leaf that the dashboard
 * can mirror.
 */

// --- process metrics --------------------------------------------------------

/** Which kind of process reported. Both roles report the same core numbers. */
export const PROCESS_ROLES = ['api', 'worker'] as const;
export const processRoleSchema = z.enum(PROCESS_ROLES);
export type ProcessRole = z.infer<typeof processRoleSchema>;

/**
 * Event-loop delay, from `perf_hooks.monitorEventLoopDelay()`.
 *
 * The whole point of the histogram (rather than a single "lag" number) is that
 * the mean hides exactly what we want to show: a build that blocks the loop
 * for 300 ms once a second barely moves the mean and doubles p99.
 *
 * Reset every tick, so each sample describes its own interval rather than the
 * process's whole life — a chart of a lifetime-cumulative histogram flattens
 * into a straight line within a minute.
 */
export const eventLoopLagSchema = z.object({
  meanMs: z.number(),
  p50Ms: z.number(),
  p99Ms: z.number(),
  maxMs: z.number(),
});
export type EventLoopLag = z.infer<typeof eventLoopLagSchema>;

/** API-only counters, from the process that serves HTTP and WebSockets. */
export const apiRuntimeMetricsSchema = z.object({
  /** Open WebSockets on *this* replica; the fan-out story is per-process. */
  sockets: z.number().int().nonnegative(),
  /** Topic subscriptions held across those sockets. */
  topics: z.number().int().nonnegative(),
  /** Redis channels this process holds a SUBSCRIBE for. */
  pubsubChannels: z.number().int().nonnegative(),
  pubsubConnected: z.boolean(),
  /** Requests completed during the last interval. */
  requests: z.number().int().nonnegative(),
  requestsPerSecond: z.number().nonnegative(),
  /** Requests in flight at sample time. */
  inflight: z.number().int().nonnegative(),
  /** 5xx responses during the last interval. */
  serverErrors: z.number().int().nonnegative(),
  /** 4xx responses during the last interval. */
  clientErrors: z.number().int().nonnegative(),
  latencyMs: z.object({
    p50: z.number().nonnegative(),
    p95: z.number().nonnegative(),
    max: z.number().nonnegative(),
  }),
});
export type ApiRuntimeMetrics = z.infer<typeof apiRuntimeMetricsSchema>;

/** Worker-only counters. */
export const workerRuntimeMetricsSchema = z.object({
  /** The worker's registry id, so the fleet view can join the two. */
  workerId: z.string().uuid().nullable(),
  status: z.string(),
  activeJobs: z.number().int().nonnegative(),
  concurrency: z.number().int().positive(),
  /** `child_process` build trees running right now. */
  activeBuilds: z.number().int().nonnegative(),
  /** False when this worker could not reach the Docker daemon at boot. */
  dockerAvailable: z.boolean(),
});
export type WorkerRuntimeMetrics = z.infer<typeof workerRuntimeMetricsSchema>;

/**
 * One process's latest sample.
 *
 * `role` + `instance` is the identity, and it is the same string the WS metric
 * frames use as their `scope` (`api:<instance>`) — so a chart fed by frames and
 * a card fed by this document key off one value rather than two conventions.
 */
export const processMetricsSchema = z.object({
  role: processRoleSchema,
  instance: z.string(),
  pid: z.number().int(),
  host: z.string(),
  nodeVersion: z.string(),
  uptimeMs: z.number().nonnegative(),
  /** How long the interval this sample describes was, in ms. */
  sampledOverMs: z.number().nonnegative(),
  /**
   * Percent of **one core** used over the interval, from two
   * `process.cpuUsage()` reads. Can exceed 100 on a threaded process (the
   * compression pool), which is the honest answer rather than a clamped one.
   */
  cpuPercent: z.number().nonnegative(),
  userCpuPercent: z.number().nonnegative(),
  systemCpuPercent: z.number().nonnegative(),
  /**
   * Event-loop utilisation: the fraction of the interval the loop was busy
   * rather than waiting for IO. 1.0 means fully saturated.
   */
  eventLoopUtilization: z.number().nonnegative(),
  eventLoopLag: eventLoopLagSchema,
  rssBytes: z.number().int().nonnegative(),
  heapUsedBytes: z.number().int().nonnegative(),
  heapTotalBytes: z.number().int().nonnegative(),
  externalBytes: z.number().int().nonnegative(),
  arrayBuffersBytes: z.number().int().nonnegative(),
  /** From `process.getActiveResourcesInfo()` — sockets, timers, handles. */
  activeResources: z.number().int().nonnegative(),
  api: apiRuntimeMetricsSchema.nullable(),
  worker: workerRuntimeMetricsSchema.nullable(),
  at: z.string(),
});
export type ProcessMetrics = z.infer<typeof processMetricsSchema>;

/** `api:forge-1` — the metric `scope` and the process document's identity. */
export function processScope(role: ProcessRole, instance: string): string {
  return `${role}:${instance}`;
}

/** Splits a scope back apart. Returns null for anything that isn't one. */
export function parseProcessScope(
  scope: string,
): { role: ProcessRole; instance: string } | null {
  const separator = scope.indexOf(':');
  if (separator <= 0) return null;
  const role = processRoleSchema.safeParse(scope.slice(0, separator));
  const instance = scope.slice(separator + 1);
  if (!role.success || instance.length === 0) return null;
  return { role: role.data, instance };
}

// --- deployment aggregates --------------------------------------------------

/**
 * Duration percentiles over the window.
 *
 * `p50`/`p95` rather than an average, because deployment durations are heavily
 * skewed — one cold `npm install` is worth thirty warm ones, and the mean then
 * describes a deployment nobody ever ran. `count` is carried so a percentile
 * computed from four samples can be labelled as such instead of charted as if
 * it meant something.
 */
export const durationStatsSchema = z.object({
  count: z.number().int().nonnegative(),
  meanMs: z.number().nonnegative().nullable(),
  p50Ms: z.number().nonnegative().nullable(),
  p95Ms: z.number().nonnegative().nullable(),
  maxMs: z.number().nonnegative().nullable(),
});
export type DurationStats = z.infer<typeof durationStatsSchema>;

/** Failure counts grouped by `StageError.code` — the histogram §6 asks for. */
export const failureBucketSchema = z.object({
  code: z.string(),
  count: z.number().int().nonnegative(),
});
export type FailureBucket = z.infer<typeof failureBucketSchema>;

/**
 * Deployment throughput and outcomes over a trailing window.
 *
 * Windowed rather than all-time: "23 failures" is meaningless without a
 * timeframe, and an all-time success rate stops moving after a few hundred
 * deployments, which makes it useless as a live signal.
 */
export const deploymentMetricsSchema = z.object({
  windowMinutes: z.number().int().positive(),
  /** Deployments *created* in the window. */
  total: z.number().int().nonnegative(),
  /**
   * Every status seen in the window, so the chart needs no second query.
   *
   * Keyed by `string` rather than by the status enum: a `z.record` over an
   * enum demands *every* key be present, and the honest shape here is "the
   * statuses that occurred" — an absent key means none, and inventing zeroes
   * for the other twelve would make the response mostly padding.
   */
  byStatus: z.record(z.string(), z.number().int().nonnegative()),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** Rows that ran more than once — the retry rate, from `attempt`. */
  retried: z.number().int().nonnegative(),
  deadLettered: z.number().int().nonnegative(),
  /** Not settled yet: still queued or somewhere in the pipeline. */
  inFlight: z.number().int().nonnegative(),
  /** null when nothing settled in the window — not zero, which would lie. */
  successRate: z.number().min(0).max(1).nullable(),
  duration: durationStatsSchema,
  failuresByCode: z.array(failureBucketSchema),
});
export type DeploymentMetrics = z.infer<typeof deploymentMetricsSchema>;

// --- the snapshot the dashboard reads ---------------------------------------

/**
 * Everything the metrics page needs, in one response.
 *
 * One endpoint rather than five, because the page wants a consistent picture:
 * five separate polls would show queue depth from one instant and deployment
 * counts from another, and the mismatch is exactly what someone debugging a
 * slow deployment would misread.
 *
 * The live half (process CPU, queue depth, container CPU) also arrives over
 * the `metrics` WS topic; this is the initial state and the fallback when the
 * socket is down.
 */
export const metricsSnapshotSchema = z.object({
  at: z.string(),
  /** Which API process answered — the same instance id as its metric scope. */
  servedBy: z.string(),
  processes: z.array(processMetricsSchema),
  queues: z.array(queueStatsSchema),
  deployments: deploymentMetricsSchema,
  /** Live containers in the requesting org, with their latest samples. */
  containers: z.array(containerStatsSchema),
  /** Postgres/Redis reachability, so one page can show the whole system. */
  dependencies: z.object({
    postgres: z.object({ ok: z.boolean(), latencyMs: z.number().int().nonnegative() }),
    redis: z.object({ ok: z.boolean(), latencyMs: z.number().int().nonnegative() }),
  }),
});
export type MetricsSnapshot = z.infer<typeof metricsSnapshotSchema>;

export const metricsQuerySchema = z.object({
  /** Trailing window for the Postgres aggregates. */
  windowMinutes: z.coerce.number().int().min(1).max(60 * 24 * 7).default(60),
});
export type MetricsQuery = z.infer<typeof metricsQuerySchema>;

// --- metric names -----------------------------------------------------------

/**
 * Every metric name, in one place.
 *
 * They are the join between three consumers that never see each other's code:
 * the publisher (worker/API), the WS frame's `name` field, and the Prometheus
 * exposition. A typo in any one of them is a chart that is silently always
 * empty, which is the worst failure mode observability has — so the names are
 * constants rather than string literals at four call sites.
 *
 * Prometheus conventions: `_bytes`, `_ms`, `_total`, `_percent` suffixes, and
 * a unit in the name rather than in a comment.
 */
export const METRIC_NAMES = {
  // process
  cpuPercent: 'process_cpu_percent',
  rssBytes: 'process_resident_memory_bytes',
  heapUsedBytes: 'process_heap_used_bytes',
  eventLoopLagP50: 'event_loop_lag_p50_ms',
  eventLoopLagP99: 'event_loop_lag_p99_ms',
  eventLoopLagMax: 'event_loop_lag_max_ms',
  eventLoopUtilization: 'event_loop_utilization',
  activeResources: 'process_active_resources',
  uptimeMs: 'process_uptime_ms',
  // api
  wsSockets: 'ws_sockets',
  wsTopics: 'ws_topics',
  httpRequestsPerSecond: 'http_requests_per_second',
  httpInflight: 'http_requests_inflight',
  httpLatencyP95: 'http_latency_p95_ms',
  // worker
  workerActiveJobs: 'worker_active_jobs',
  workerActiveBuilds: 'worker_active_builds',
  // queue
  queueWaiting: 'queue_waiting',
  queueActive: 'queue_active',
  queueDelayed: 'queue_delayed',
  queueFailed: 'queue_failed',
  // container
  containerCpuPercent: 'container_cpu_percent',
  containerMemoryBytes: 'container_memory_bytes',
  containerMemoryPercent: 'container_memory_percent',
  containerPids: 'container_pids',
  // deployment
  deploymentDurationMs: 'deployment_duration_ms',
} as const;

/** Prefix on every exported Prometheus series. */
export const PROMETHEUS_PREFIX = 'forge';

// --- helpers ----------------------------------------------------------------

/**
 * Nearest-rank percentile over an **unsorted** array (it sorts a copy).
 *
 * Nearest-rank rather than interpolating: these are latency samples, and
 * reporting a p95 that no request actually experienced is a small lie that
 * gets repeated on every chart. Returns null for an empty input, so "no data"
 * never renders as 0 ms.
 */
export function percentileOf(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index] ?? null;
}

/** Mean, or null for an empty input — same reasoning as `percentileOf`. */
export function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** Rounds to `decimals` places without `toFixed`'s string round-trip. */
export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
