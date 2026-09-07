import type { MetricsSnapshot, ProcessMetrics } from '@/lib/api';

/**
 * The browser's side of the metrics stream.
 *
 * Metric frames arrive on the `metrics` WebSocket topic a few times a second
 * and carry one number each. Charts need a *series*, so something has to hold
 * the recent past — and that something is deliberately here, in memory, and
 * deliberately *not* the server's problem: a history endpoint would mean
 * storing every sample in Postgres forever to serve a chart that only ever
 * shows the last two minutes.
 *
 * The consequence is stated plainly in the UI: the charts start empty on load
 * and fill in as samples arrive. That is honest for a live monitor, and it is
 * why the numeric tiles beside them come from the REST snapshot, which is
 * complete the moment the page opens.
 */

/** Metric names, mirroring `METRIC_NAMES` in @forge/shared. */
export const METRICS = {
  cpuPercent: 'process_cpu_percent',
  rssBytes: 'process_resident_memory_bytes',
  heapUsedBytes: 'process_heap_used_bytes',
  eventLoopLagP50: 'event_loop_lag_p50_ms',
  eventLoopLagP99: 'event_loop_lag_p99_ms',
  eventLoopLagMax: 'event_loop_lag_max_ms',
  eventLoopUtilization: 'event_loop_utilization',
  activeResources: 'process_active_resources',
  wsSockets: 'ws_sockets',
  wsTopics: 'ws_topics',
  httpRequestsPerSecond: 'http_requests_per_second',
  httpInflight: 'http_requests_inflight',
  httpLatencyP95: 'http_latency_p95_ms',
  workerActiveJobs: 'worker_active_jobs',
  workerActiveBuilds: 'worker_active_builds',
  queueWaiting: 'queue_waiting',
  queueActive: 'queue_active',
  queueDelayed: 'queue_delayed',
  queueFailed: 'queue_failed',
  containerCpuPercent: 'container_cpu_percent',
  containerMemoryBytes: 'container_memory_bytes',
  containerMemoryPercent: 'container_memory_percent',
  containerPids: 'container_pids',
} as const;

/** One plotted point. `t` is epoch ms so the x-axis is real time, not an index. */
export type Point = { t: number; v: number };

/**
 * How many points a series keeps.
 *
 * 150 at the default 2 s cadence is five minutes of history — long enough to
 * see a deployment's whole build in one frame, short enough that a page left
 * open overnight does not accumulate a megabyte of numbers nobody will scroll
 * back to.
 */
export const SERIES_CAPACITY = 150;

/** `<scope>|<name>` — the key a chart asks for. */
export function seriesKey(scope: string, name: string): string {
  return `${scope}|${name}`;
}

/**
 * A bounded ring of series, keyed by scope+metric.
 *
 * A plain object mutated in place rather than React state: frames arrive
 * several times a second across a dozen series, and setting state per frame
 * would re-render the page on every one. The page instead re-renders on a
 * fixed timer and reads whatever is in here — the classic "high-frequency
 * data, low-frequency paint" split, and the reason the charts stay smooth
 * while the socket is busy.
 */
export class MetricSeries {
  readonly #series = new Map<string, Point[]>();
  /** Bumped on every push, so a paint tick can skip work when nothing came. */
  #version = 0;

  get version(): number {
    return this.#version;
  }

  push(scope: string, name: string, value: number, at: string): void {
    if (!Number.isFinite(value)) return;
    const key = seriesKey(scope, name);
    let points = this.#series.get(key);
    if (!points) {
      points = [];
      this.#series.set(key, points);
    }
    const t = Date.parse(at);
    points.push({ t: Number.isNaN(t) ? Date.now() : t, v: value });
    if (points.length > SERIES_CAPACITY) points.splice(0, points.length - SERIES_CAPACITY);
    this.#version += 1;
  }

  /** The series, or an empty array — never undefined, so charts stay simple. */
  get(scope: string, name: string): Point[] {
    return this.#series.get(seriesKey(scope, name)) ?? [];
  }

  /** Latest value of one series, or null when nothing has arrived yet. */
  latest(scope: string, name: string): number | null {
    const points = this.#series.get(seriesKey(scope, name));
    return points && points.length > 0 ? (points[points.length - 1]?.v ?? null) : null;
  }

  /** Every scope that has reported a given metric — used to find containers. */
  scopesFor(name: string): string[] {
    const suffix = `|${name}`;
    const scopes: string[] = [];
    for (const key of this.#series.keys()) {
      if (key.endsWith(suffix)) scopes.push(key.slice(0, -suffix.length));
    }
    return scopes;
  }

  /**
   * Drops series whose scope is no longer live.
   *
   * Without this, every restarted worker and every stopped container leaves a
   * dead series in memory and, worse, a flat line on the chart that looks like
   * a process sitting at its last value forever.
   */
  retain(liveScopes: ReadonlySet<string>): void {
    for (const key of [...this.#series.keys()]) {
      const scope = key.slice(0, key.lastIndexOf('|'));
      if (!liveScopes.has(scope)) this.#series.delete(key);
    }
  }
}

/** `api:<instance>` — matches `processScope()` on the server. */
export function processScope(process: Pick<ProcessMetrics, 'role' | 'instance'>): string {
  return `${process.role}:${process.instance}`;
}

/** Every scope a snapshot says is currently alive, for `retain()`. */
export function liveScopes(snapshot: MetricsSnapshot | undefined): Set<string> {
  const scopes = new Set<string>();
  if (!snapshot) return scopes;
  for (const process of snapshot.processes) scopes.add(processScope(process));
  for (const queue of snapshot.queues) scopes.add(`queue:${queue.name}`);
  for (const container of snapshot.containers) scopes.add(`container:${container.deploymentId}`);
  return scopes;
}

/**
 * Seeds a series from the snapshot, so a freshly loaded page is not blank.
 *
 * One point per series — the snapshot is a single instant, not a history — but
 * it means every chart has a starting value and a legend entry immediately,
 * instead of appearing to be broken for the first two seconds.
 */
export function seedFromSnapshot(series: MetricSeries, snapshot: MetricsSnapshot): void {
  for (const process of snapshot.processes) {
    const scope = processScope(process);
    series.push(scope, METRICS.cpuPercent, process.cpuPercent, process.at);
    series.push(scope, METRICS.rssBytes, process.rssBytes, process.at);
    series.push(scope, METRICS.heapUsedBytes, process.heapUsedBytes, process.at);
    series.push(scope, METRICS.eventLoopLagP50, process.eventLoopLag.p50Ms, process.at);
    series.push(scope, METRICS.eventLoopLagP99, process.eventLoopLag.p99Ms, process.at);
    if (process.api) {
      series.push(scope, METRICS.wsSockets, process.api.sockets, process.at);
      series.push(scope, METRICS.httpRequestsPerSecond, process.api.requestsPerSecond, process.at);
      series.push(scope, METRICS.httpLatencyP95, process.api.latencyMs.p95, process.at);
    }
    if (process.worker) {
      series.push(scope, METRICS.workerActiveJobs, process.worker.activeJobs, process.at);
      series.push(scope, METRICS.workerActiveBuilds, process.worker.activeBuilds, process.at);
    }
  }
  for (const queue of snapshot.queues) {
    if (!queue.available) continue;
    const scope = `queue:${queue.name}`;
    series.push(scope, METRICS.queueWaiting, queue.waiting, snapshot.at);
    series.push(scope, METRICS.queueActive, queue.active, snapshot.at);
    series.push(scope, METRICS.queueDelayed, queue.delayed, snapshot.at);
  }
  for (const container of snapshot.containers) {
    const scope = `container:${container.deploymentId}`;
    series.push(scope, METRICS.containerCpuPercent, container.cpuPercent, container.at);
    series.push(scope, METRICS.containerMemoryBytes, container.memoryBytes, container.at);
  }
}
