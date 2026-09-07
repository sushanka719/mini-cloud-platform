import {
  METRIC_NAMES,
  processScope,
  round,
  type ApiRuntimeMetrics,
  type MetricMessage,
  type ProcessMetrics,
  type ProcessRole,
  type QueueStats,
  type WorkerRuntimeMetrics,
} from '@forge/shared';
import { ProcessSampler } from './process-sampler.js';

/**
 * The thing that turns measurements into shared state, on a timer.
 *
 * Two outputs per tick, because they answer two different questions:
 *
 *  - **`store`** writes the whole document to Redis under a TTL. That is the
 *    *state* — "what is this process doing right now" — and it is what lets an
 *    API replica render the entire fleet, including workers it has never
 *    spoken to and API replicas it does not know exist. A process that dies
 *    stops refreshing the key and drops off the page on its own (CLAUDE.md §4:
 *    nothing authoritative in process memory).
 *  - **`publish`** emits individual samples on the `metrics` Pub/Sub channel.
 *    That is the *stream* — what the dashboard charts without polling.
 *
 * Both sinks are injected rather than imported. `@forge/metrics` depends only
 * on `@forge/shared` (ARCHITECTURE §9), so it does not get to open a Redis
 * connection; the API and the worker each already own one with the right retry
 * rules, and they pass in two functions.
 *
 * Nothing here is allowed to be fatal. Observability that can take the process
 * down is worse than no observability, so every tick is wrapped and a failure
 * is a warning plus a skipped interval.
 */

/** Minimal logger shape, so this package need not depend on `@forge/config`. */
export type MetricsLogger = {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export type MetricsSink = {
  /** Persist one process document as shared state. */
  store: (metrics: ProcessMetrics) => Promise<void>;
  /** Fan samples out on the `metrics` channel. Best-effort. */
  publish: (samples: MetricMessage[]) => Promise<void>;
};

/**
 * Role-specific counters, read fresh on each tick.
 *
 * A callback rather than a constructor argument because these come from
 * objects that outlive and out-mutate the reporter — the set of open sockets,
 * the worker registry's active job set — and a snapshot taken at construction
 * would report the process's first millisecond forever.
 */
export type MetricsExtras = () => {
  api?: ApiRuntimeMetrics | null;
  worker?: WorkerRuntimeMetrics | null;
};

export type MetricsReporterOptions = {
  role: ProcessRole;
  /** This process's id — the same string used in WS `hello` / worker names. */
  instance: string;
  /** 0 disables reporting entirely. */
  intervalMs: number;
  sink: MetricsSink;
  extras?: MetricsExtras;
  log: MetricsLogger;
  /**
   * Extra samples to publish alongside this process's own, when this process
   * wins the election for them (queue depth). Resolving to `[]` is the normal
   * case for every process that lost.
   */
  additional?: () => Promise<MetricMessage[]>;
};

export class MetricsReporter {
  readonly #sampler = new ProcessSampler();
  readonly #options: MetricsReporterOptions;
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  /** The most recent document, so `/metrics` can serve this process directly. */
  #latest: ProcessMetrics | null = null;

  constructor(options: MetricsReporterOptions) {
    this.#options = options;
  }

  get scope(): string {
    return processScope(this.#options.role, this.#options.instance);
  }

  /** The last document produced, or null before the first tick. */
  get latest(): ProcessMetrics | null {
    return this.#latest;
  }

  start(): void {
    const { intervalMs, log, role } = this.#options;
    if (intervalMs === 0) {
      log.info({ role }, 'metrics reporter disabled (METRICS_INTERVAL_MS=0)');
      return;
    }
    this.#sampler.start();
    // One tick immediately, so a freshly started process appears on the
    // dashboard now rather than one interval from now. The sampler was
    // re-anchored by start() a microsecond ago, so this first sample describes
    // a very short interval — honest, and labelled as such by `sampledOverMs`.
    void this.tick();
    this.#timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    // Never keep the process alive for a metrics tick.
    this.#timer.unref();
    log.info({ role, intervalMs, scope: this.scope }, 'metrics reporter started');
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#sampler.stop();
  }

  /** One sample-store-publish pass. Public so a script can force one. */
  async tick(): Promise<ProcessMetrics | null> {
    // A slow Redis must not queue ticks behind each other; for a sampler the
    // next reading is as good as this one, so skipping is correct.
    if (this.#running) return this.#latest;
    this.#running = true;
    try {
      const sample = this.#sampler.sample();
      const extras = this.#options.extras?.() ?? {};
      const metrics: ProcessMetrics = {
        role: this.#options.role,
        instance: this.#options.instance,
        ...sample,
        api: extras.api ?? null,
        worker: extras.worker ?? null,
        at: new Date().toISOString(),
      };
      this.#latest = metrics;

      const samples = processMetricSamples(metrics);
      if (this.#options.additional) {
        try {
          samples.push(...(await this.#options.additional()));
        } catch (err) {
          this.#options.log.debug({ err }, 'additional metric samples failed');
        }
      }

      // Settled, not awaited in sequence: a Redis write that fails must not
      // stop the publish, and neither must fail the tick.
      const [stored, published] = await Promise.allSettled([
        this.#options.sink.store(metrics),
        this.#options.sink.publish(samples),
      ]);
      if (stored.status === 'rejected') {
        this.#options.log.debug({ err: stored.reason }, 'could not store process metrics');
      }
      if (published.status === 'rejected') {
        this.#options.log.debug({ err: published.reason }, 'could not publish metrics');
      }
      return metrics;
    } catch (err) {
      this.#options.log.warn({ err }, 'metrics tick failed');
      return this.#latest;
    } finally {
      this.#running = false;
    }
  }
}

/** Builds one frame. Kept private so `at` and `scope` can never disagree. */
function sample(scope: string, at: string, name: string, value: number, unit: string | null): MetricMessage {
  return { type: 'metric', scope, name, value, unit, at };
}

/**
 * The samples worth putting on the wire for one process document.
 *
 * A deliberate subset — not every field of `ProcessMetrics`. The document is
 * already in Redis for anyone who wants the whole picture; the stream exists
 * for the numbers that only mean something as a *series*, and publishing
 * `nodeVersion` a few times a second would be noise with a timestamp.
 */
export function processMetricSamples(metrics: ProcessMetrics): MetricMessage[] {
  const scope = processScope(metrics.role, metrics.instance);
  const at = metrics.at;
  const samples = [
    sample(scope, at, METRIC_NAMES.cpuPercent, metrics.cpuPercent, 'percent'),
    sample(scope, at, METRIC_NAMES.rssBytes, metrics.rssBytes, 'bytes'),
    sample(scope, at, METRIC_NAMES.heapUsedBytes, metrics.heapUsedBytes, 'bytes'),
    sample(scope, at, METRIC_NAMES.eventLoopLagP50, metrics.eventLoopLag.p50Ms, 'ms'),
    sample(scope, at, METRIC_NAMES.eventLoopLagP99, metrics.eventLoopLag.p99Ms, 'ms'),
    sample(scope, at, METRIC_NAMES.eventLoopLagMax, metrics.eventLoopLag.maxMs, 'ms'),
    sample(scope, at, METRIC_NAMES.eventLoopUtilization, metrics.eventLoopUtilization, 'ratio'),
    sample(scope, at, METRIC_NAMES.activeResources, metrics.activeResources, null),
  ];

  if (metrics.api) {
    samples.push(
      sample(scope, at, METRIC_NAMES.wsSockets, metrics.api.sockets, null),
      sample(scope, at, METRIC_NAMES.wsTopics, metrics.api.topics, null),
      sample(scope, at, METRIC_NAMES.httpRequestsPerSecond, metrics.api.requestsPerSecond, 'rps'),
      sample(scope, at, METRIC_NAMES.httpInflight, metrics.api.inflight, null),
      sample(scope, at, METRIC_NAMES.httpLatencyP95, metrics.api.latencyMs.p95, 'ms'),
    );
  }
  if (metrics.worker) {
    samples.push(
      sample(scope, at, METRIC_NAMES.workerActiveJobs, metrics.worker.activeJobs, null),
      sample(scope, at, METRIC_NAMES.workerActiveBuilds, metrics.worker.activeBuilds, null),
    );
  }
  return samples;
}

/**
 * Queue depth as samples, scoped `queue:<name>`.
 *
 * Published by exactly one process per tick (elected with a short Redis
 * lease), because the counters are a property of the *queue*, not of the
 * process reading them — three API replicas each publishing them would chart
 * three times the real depth.
 */
export function queueMetricSamples(queues: readonly QueueStats[], at: string): MetricMessage[] {
  const samples: MetricMessage[] = [];
  for (const queue of queues) {
    // An unreadable queue publishes nothing rather than zeroes: a chart that
    // drops to 0 when Redis blips reads as "the backlog cleared".
    if (!queue.available) continue;
    const scope = `queue:${queue.name}`;
    samples.push(
      sample(scope, at, METRIC_NAMES.queueWaiting, queue.waiting, null),
      sample(scope, at, METRIC_NAMES.queueActive, queue.active, null),
      sample(scope, at, METRIC_NAMES.queueDelayed, queue.delayed, null),
      sample(scope, at, METRIC_NAMES.queueFailed, queue.failed, null),
    );
  }
  return samples;
}

/**
 * One container's sample as metric frames, scoped `container:<deploymentId>`.
 *
 * These do **not** go on the global `metrics` channel — a container belongs to
 * one org, and the `metrics` topic is readable by any authenticated member, so
 * putting them there would be a cross-tenant leak. The worker publishes them
 * on `deployment:<id>` / `project:<id>` / `org:<id>` instead, which are the
 * channels whose subscriptions are already authorized per tenant.
 */
export function containerMetricSamples(stats: {
  deploymentId: string;
  cpuPercent: number;
  memoryBytes: number;
  memoryPercent: number;
  pids: number;
  at: string;
}): MetricMessage[] {
  const scope = `container:${stats.deploymentId}`;
  return [
    sample(scope, stats.at, METRIC_NAMES.containerCpuPercent, round(stats.cpuPercent, 2), 'percent'),
    sample(scope, stats.at, METRIC_NAMES.containerMemoryBytes, stats.memoryBytes, 'bytes'),
    sample(scope, stats.at, METRIC_NAMES.containerMemoryPercent, round(stats.memoryPercent, 2), 'percent'),
    sample(scope, stats.at, METRIC_NAMES.containerPids, stats.pids, null),
  ];
}
