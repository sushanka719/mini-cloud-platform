import {
  METRIC_NAMES,
  PROMETHEUS_PREFIX,
  type MetricsSnapshot,
  type ProcessMetrics,
} from '@forge/shared';

/**
 * The Prometheus text exposition format, written by hand.
 *
 * `prom-client` is the obvious dependency and is deliberately not used:
 * ARCHITECTURE §6 names `/metrics` as one of the things this project exists to
 * implement, and the format is a dozen lines of string building. What the
 * library would actually buy us — a registry, label validation, histogram
 * bucketing — we either don't need or already have in `@forge/shared`.
 *
 * The format itself, briefly, because getting it subtly wrong yields a scrape
 * that silently drops series:
 *
 *   # HELP <name> <one-line description>
 *   # TYPE <name> gauge|counter|summary
 *   <name>{<label>="<value>",…} <number>
 *
 * Rules that matter here: one `HELP`/`TYPE` pair per metric name (repeating a
 * TYPE for the same name is a parse error), label values are quoted and must
 * escape `\`, `"` and newlines, and `NaN`/`Inf` are legal but useless — so a
 * missing value is omitted rather than emitted as 0.
 */

type Labels = Record<string, string | number | null | undefined>;

/** Escapes a label value per the exposition format. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderLabels(labels: Labels): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(labels)) {
    if (value === null || value === undefined) continue;
    parts.push(`${key}="${escapeLabel(String(value))}"`);
  }
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

/**
 * Accumulates lines, keeping one HELP/TYPE header per metric name.
 *
 * The header bookkeeping is the whole reason this is a class: series for the
 * same metric come from different loops (one per process, one per queue), and
 * emitting the header inside those loops would repeat it — which Prometheus
 * rejects rather than tolerates.
 */
class Exposition {
  readonly #lines: string[] = [];
  readonly #declared = new Set<string>();

  #name(metric: string): string {
    return `${PROMETHEUS_PREFIX}_${metric}`;
  }

  declare(metric: string, help: string, type: 'gauge' | 'counter' | 'summary'): void {
    const name = this.#name(metric);
    if (this.#declared.has(name)) return;
    this.#declared.add(name);
    this.#lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  }

  /** Adds a sample. A null/non-finite value is skipped, not zeroed. */
  sample(metric: string, value: number | null | undefined, labels: Labels = {}): void {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    this.#lines.push(`${this.#name(metric)}${renderLabels(labels)} ${String(value)}`);
  }

  render(): string {
    // A trailing newline is required by the format; some scrapers drop the
    // last series without it.
    return `${this.#lines.join('\n')}\n`;
  }
}

function processLabels(metrics: ProcessMetrics): Labels {
  return { role: metrics.role, instance: metrics.instance, pid: metrics.pid, host: metrics.host };
}

/**
 * Renders one scrape from a snapshot.
 *
 * The snapshot covers the *whole fleet*, not just the process answering the
 * scrape — every process's document is in Redis, so one endpoint on one
 * replica exposes every API replica and every worker. That is unusual for
 * Prometheus (which would normally scrape each process directly) and is the
 * right trade here: workers serve no HTTP at all, so without this they would
 * be unscrapeable.
 */
export function renderPrometheus(snapshot: MetricsSnapshot): string {
  const out = new Exposition();

  // --- process ---
  out.declare('process_up', 'One per process reporting metrics.', 'gauge');
  out.declare(METRIC_NAMES.cpuPercent, 'CPU used over the last interval, percent of one core.', 'gauge');
  out.declare(METRIC_NAMES.rssBytes, 'Resident set size in bytes.', 'gauge');
  out.declare(METRIC_NAMES.heapUsedBytes, 'V8 heap in use, in bytes.', 'gauge');
  out.declare('process_heap_total_bytes', 'V8 heap reserved, in bytes.', 'gauge');
  out.declare('process_external_bytes', 'Memory held outside the V8 heap (Buffers), in bytes.', 'gauge');
  out.declare(METRIC_NAMES.eventLoopLagP50, 'Event-loop delay, 50th percentile, ms.', 'gauge');
  out.declare(METRIC_NAMES.eventLoopLagP99, 'Event-loop delay, 99th percentile, ms.', 'gauge');
  out.declare(METRIC_NAMES.eventLoopLagMax, 'Worst event-loop delay in the interval, ms.', 'gauge');
  out.declare(METRIC_NAMES.eventLoopUtilization, 'Fraction of the interval the event loop was busy.', 'gauge');
  out.declare(METRIC_NAMES.activeResources, 'Resources keeping the event loop alive.', 'gauge');
  out.declare(METRIC_NAMES.uptimeMs, 'Process uptime in ms.', 'gauge');

  for (const process of snapshot.processes) {
    const labels = processLabels(process);
    out.sample('process_up', 1, labels);
    out.sample(METRIC_NAMES.cpuPercent, process.cpuPercent, labels);
    out.sample(METRIC_NAMES.rssBytes, process.rssBytes, labels);
    out.sample(METRIC_NAMES.heapUsedBytes, process.heapUsedBytes, labels);
    out.sample('process_heap_total_bytes', process.heapTotalBytes, labels);
    out.sample('process_external_bytes', process.externalBytes, labels);
    out.sample(METRIC_NAMES.eventLoopLagP50, process.eventLoopLag.p50Ms, labels);
    out.sample(METRIC_NAMES.eventLoopLagP99, process.eventLoopLag.p99Ms, labels);
    out.sample(METRIC_NAMES.eventLoopLagMax, process.eventLoopLag.maxMs, labels);
    out.sample(METRIC_NAMES.eventLoopUtilization, process.eventLoopUtilization, labels);
    out.sample(METRIC_NAMES.activeResources, process.activeResources, labels);
    out.sample(METRIC_NAMES.uptimeMs, process.uptimeMs, labels);
  }

  // --- api ---
  const apis = snapshot.processes.filter((process) => process.api !== null);
  if (apis.length > 0) {
    out.declare(METRIC_NAMES.wsSockets, 'Open WebSockets on this API replica.', 'gauge');
    out.declare(METRIC_NAMES.wsTopics, 'Topic subscriptions held across those sockets.', 'gauge');
    out.declare('ws_pubsub_channels', 'Redis channels this replica holds a SUBSCRIBE for.', 'gauge');
    out.declare(METRIC_NAMES.httpRequestsPerSecond, 'Requests completed per second over the last interval.', 'gauge');
    out.declare(METRIC_NAMES.httpInflight, 'Requests in flight.', 'gauge');
    out.declare(METRIC_NAMES.httpLatencyP95, 'Request latency, 95th percentile, ms.', 'gauge');
    out.declare('http_errors', 'Error responses in the last interval, by class.', 'gauge');

    for (const process of apis) {
      const api = process.api;
      if (!api) continue;
      const labels = processLabels(process);
      out.sample(METRIC_NAMES.wsSockets, api.sockets, labels);
      out.sample(METRIC_NAMES.wsTopics, api.topics, labels);
      out.sample('ws_pubsub_channels', api.pubsubChannels, labels);
      out.sample(METRIC_NAMES.httpRequestsPerSecond, api.requestsPerSecond, labels);
      out.sample(METRIC_NAMES.httpInflight, api.inflight, labels);
      out.sample(METRIC_NAMES.httpLatencyP95, api.latencyMs.p95, labels);
      out.sample('http_errors', api.clientErrors, { ...labels, class: '4xx' });
      out.sample('http_errors', api.serverErrors, { ...labels, class: '5xx' });
    }
  }

  // --- worker ---
  const workers = snapshot.processes.filter((process) => process.worker !== null);
  if (workers.length > 0) {
    out.declare(METRIC_NAMES.workerActiveJobs, 'Deployment jobs this worker is running.', 'gauge');
    out.declare(METRIC_NAMES.workerActiveBuilds, 'child_process build trees running.', 'gauge');
    out.declare('worker_concurrency', 'Jobs this worker will run at once.', 'gauge');
    out.declare('worker_docker_available', '1 when the worker could reach the Docker daemon.', 'gauge');

    for (const process of workers) {
      const worker = process.worker;
      if (!worker) continue;
      const labels = { ...processLabels(process), status: worker.status };
      out.sample(METRIC_NAMES.workerActiveJobs, worker.activeJobs, labels);
      out.sample(METRIC_NAMES.workerActiveBuilds, worker.activeBuilds, labels);
      out.sample('worker_concurrency', worker.concurrency, labels);
      out.sample('worker_docker_available', worker.dockerAvailable ? 1 : 0, labels);
    }
  }

  // --- queues ---
  out.declare(METRIC_NAMES.queueWaiting, 'Jobs waiting in the queue.', 'gauge');
  out.declare(METRIC_NAMES.queueActive, 'Jobs being processed.', 'gauge');
  out.declare(METRIC_NAMES.queueDelayed, 'Jobs scheduled for a later retry.', 'gauge');
  out.declare(METRIC_NAMES.queueFailed, 'Jobs BullMQ is retaining as failed.', 'gauge');
  out.declare('queue_completed', 'Jobs BullMQ is retaining as completed.', 'gauge');
  out.declare('queue_available', '1 when the queue counters could be read.', 'gauge');
  out.declare('queue_paused', '1 when the queue is paused.', 'gauge');

  for (const queue of snapshot.queues) {
    const labels: Labels = { queue: queue.name };
    out.sample('queue_available', queue.available ? 1 : 0, labels);
    // Counters are omitted entirely for an unreadable queue: zero would be
    // charted as "the backlog cleared", which is the opposite of the truth.
    if (!queue.available) continue;
    out.sample(METRIC_NAMES.queueWaiting, queue.waiting, labels);
    out.sample(METRIC_NAMES.queueActive, queue.active, labels);
    out.sample(METRIC_NAMES.queueDelayed, queue.delayed, labels);
    out.sample(METRIC_NAMES.queueFailed, queue.failed, labels);
    out.sample('queue_completed', queue.completed, labels);
    out.sample('queue_paused', queue.paused ? 1 : 0, labels);
  }

  // --- deployments ---
  const deployments = snapshot.deployments;
  const window = { window_minutes: deployments.windowMinutes };
  out.declare('deployments_total', 'Deployments created in the window.', 'gauge');
  out.declare('deployments_by_status', 'Deployments in the window, by current status.', 'gauge');
  out.declare('deployments_retried', 'Deployments in the window that ran more than once.', 'gauge');
  out.declare('deployments_dead_lettered', 'Deployments in the window whose retry budget ran out.', 'gauge');
  out.declare('deployments_in_flight', 'Deployments in the window not yet settled.', 'gauge');
  out.declare('deployments_success_rate', 'Successful share of settled deployments in the window.', 'gauge');
  out.declare('deployment_failures', 'Failures in the window, by error code.', 'gauge');
  out.declare(METRIC_NAMES.deploymentDurationMs, 'Deployment wall-clock duration in the window, ms.', 'summary');

  out.sample('deployments_total', deployments.total, window);
  out.sample('deployments_retried', deployments.retried, window);
  out.sample('deployments_dead_lettered', deployments.deadLettered, window);
  out.sample('deployments_in_flight', deployments.inFlight, window);
  out.sample('deployments_success_rate', deployments.successRate, window);
  for (const [status, count] of Object.entries(deployments.byStatus)) {
    out.sample('deployments_by_status', count, { ...window, status });
  }
  for (const bucket of deployments.failuresByCode) {
    out.sample('deployment_failures', bucket.count, { ...window, code: bucket.code });
  }
  // A summary's quantiles are labelled samples of the base name; the count is
  // a separate `_count` series, which is why it is emitted without a declare.
  out.sample(METRIC_NAMES.deploymentDurationMs, deployments.duration.p50Ms, { ...window, quantile: '0.5' });
  out.sample(METRIC_NAMES.deploymentDurationMs, deployments.duration.p95Ms, { ...window, quantile: '0.95' });
  out.sample(METRIC_NAMES.deploymentDurationMs, deployments.duration.maxMs, { ...window, quantile: '1' });
  out.sample(`${METRIC_NAMES.deploymentDurationMs}_count`, deployments.duration.count, window);

  // --- containers ---
  if (snapshot.containers.length > 0) {
    out.declare(METRIC_NAMES.containerCpuPercent, 'Container CPU, percent of one core.', 'gauge');
    out.declare(METRIC_NAMES.containerMemoryBytes, 'Container memory in use, bytes.', 'gauge');
    out.declare('container_memory_limit_bytes', 'Container memory cap, bytes.', 'gauge');
    out.declare(METRIC_NAMES.containerPids, 'Processes inside the container.', 'gauge');

    for (const stats of snapshot.containers) {
      const labels: Labels = {
        deployment: stats.deploymentId,
        container: stats.containerId.slice(0, 12),
        state: stats.state,
      };
      out.sample(METRIC_NAMES.containerCpuPercent, stats.cpuPercent, labels);
      out.sample(METRIC_NAMES.containerMemoryBytes, stats.memoryBytes, labels);
      out.sample('container_memory_limit_bytes', stats.memoryLimitBytes, labels);
      out.sample(METRIC_NAMES.containerPids, stats.pids, labels);
    }
  }

  // --- dependencies ---
  out.declare('dependency_up', '1 when the dependency answered its probe.', 'gauge');
  out.declare('dependency_latency_ms', 'How long the dependency took to answer, ms.', 'gauge');
  for (const [name, check] of Object.entries(snapshot.dependencies)) {
    out.sample('dependency_up', check.ok ? 1 : 0, { dependency: name });
    out.sample('dependency_latency_ms', check.latencyMs, { dependency: name });
  }

  return out.render();
}

/** The content type a Prometheus scrape expects. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
