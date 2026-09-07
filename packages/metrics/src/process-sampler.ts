import { hostname } from 'node:os';
import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'node:perf_hooks';
import { round, type EventLoopLag } from '@forge/shared';

/**
 * Measuring one Node process, by hand.
 *
 * CLAUDE.md §4 lists observability as a place we deliberately stay low-level,
 * so this is `perf_hooks` and `process.*` directly rather than a metrics
 * library. Four things, and each one has a reason for the exact API used:
 *
 *  - **Event-loop delay** — `monitorEventLoopDelay()` is a libuv-level
 *    histogram: it schedules a timer at a fixed resolution and records the
 *    interval each firing actually took (see `toLagMs` for why the resolution
 *    then has to come back off). Sampling `Date.now()` in a `setInterval`
 *    ourselves would measure the same thing far more coarsely and only while
 *    the loop was already free enough to run our callback.
 *  - **Event-loop utilisation** — `performance.eventLoopUtilization()` is the
 *    complement: not "how late was a timer" but "what fraction of wall clock
 *    was the loop busy rather than parked in `epoll_wait`". Lag says the loop
 *    is *blocked*; utilisation says it is *saturated*, and a build worker
 *    shows both at once.
 *  - **CPU** — `process.cpuUsage()` is cumulative microseconds, so a
 *    percentage only exists between two reads. Divided by the wall-clock
 *    interval it is percent of one core, which is why it can exceed 100 in a
 *    process with worker threads (our compression pool).
 *  - **Memory** — `process.memoryUsage()`. RSS is what the OS charges us;
 *    heap is what V8 is using inside that. Both, because a leak in a Buffer
 *    (external) moves RSS and barely moves the heap.
 *
 * Every reading is *interval-scoped*: the histogram is reset and the CPU/ELU
 * baselines are re-anchored on each `sample()`. A cumulative histogram
 * flattens into a straight line within a minute of uptime, which makes it
 * useless as a live chart — the thing this exists to feed.
 */

/** Histogram resolution: how often libuv checks its own timer lateness. */
const LOOP_RESOLUTION_MS = 10;

/** The process-level numbers, before either role's extras are attached. */
export type ProcessSample = {
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
};

export class ProcessSampler {
  readonly pid = process.pid;
  readonly host = hostname();

  readonly #loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  #lastCpu = process.cpuUsage();
  #lastElu: EventLoopUtilization = performance.eventLoopUtilization();
  #lastAt = performance.now();
  #enabled = false;

  /**
   * Starts the histogram.
   *
   * Separate from the constructor so a process can construct the sampler at
   * import time and only pay for it once observability is actually switched on
   * (`METRICS_INTERVAL_MS=0` disables the reporter entirely).
   */
  start(): void {
    if (this.#enabled) return;
    this.#loop.enable();
    this.#enabled = true;
    // Re-anchor: the deltas below are only meaningful from the moment we start.
    this.#lastCpu = process.cpuUsage();
    this.#lastElu = performance.eventLoopUtilization();
    this.#lastAt = performance.now();
  }

  stop(): void {
    if (!this.#enabled) return;
    this.#loop.disable();
    this.#enabled = false;
  }

  /**
   * Reads every counter and re-anchors for the next interval.
   *
   * Not idempotent, on purpose: calling it twice in a row gives the second
   * call a near-zero interval, and a CPU percentage over a 0 ms window is a
   * division by nothing. One caller (the reporter) owns the cadence.
   */
  sample(): ProcessSample {
    const now = performance.now();
    const elapsedMs = Math.max(1, now - this.#lastAt);

    // `cpuUsage(previous)` returns the delta directly — microseconds of CPU
    // since that reading, which over `elapsedMs` of wall clock is a fraction
    // of one core.
    const cpu = process.cpuUsage(this.#lastCpu);
    const elu = performance.eventLoopUtilization(this.#lastElu);
    const memory = process.memoryUsage();

    const toPercent = (micros: number): number => round((micros / 1000 / elapsedMs) * 100, 2);

    const lag: EventLoopLag = {
      meanMs: round(toLagMs(this.#loop.mean), 2),
      p50Ms: round(toLagMs(this.#loop.percentile(50)), 2),
      p99Ms: round(toLagMs(this.#loop.percentile(99)), 2),
      maxMs: round(toLagMs(this.#loop.max), 2),
    };

    this.#loop.reset();
    this.#lastCpu = process.cpuUsage();
    this.#lastElu = performance.eventLoopUtilization();
    this.#lastAt = now;

    return {
      pid: this.pid,
      host: this.host,
      nodeVersion: process.version,
      uptimeMs: Math.round(process.uptime() * 1000),
      sampledOverMs: Math.round(elapsedMs),
      cpuPercent: toPercent(cpu.user + cpu.system),
      userCpuPercent: toPercent(cpu.user),
      systemCpuPercent: toPercent(cpu.system),
      eventLoopUtilization: round(elu.utilization, 4),
      eventLoopLag: lag,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      // The public replacement for `process._getActiveHandles()`: every
      // resource keeping the loop alive, as strings. A steadily climbing count
      // is the shape of a handle leak.
      activeResources: process.getActiveResourcesInfo().length,
    };
  }
}

/**
 * One histogram reading, in milliseconds of *excess* delay.
 *
 * Two corrections, both necessary for the number to mean what it says:
 *
 *  - **Nanoseconds → milliseconds.** The histogram is in ns; everything we
 *    report is ms.
 *  - **Minus the resolution.** libuv records the *whole* interval between
 *    timer firings, not the lateness — so a completely idle process reports
 *    ~10 ms with a 10 ms resolution. Charting that gives every healthy process
 *    a permanent 10 ms floor and makes a real 40 ms stall look like a 4×
 *    increase instead of the 40 ms it is. Subtracting the resolution (floored
 *    at 0, since a firing can be marginally early) reports the delay
 *    attributable to the loop being busy, which is the thing being measured.
 *
 * An empty interval — no firings recorded — leaves `mean` as `NaN`, which
 * would fail the response schema on the way out, so it reports 0.
 */
function toLagMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value / 1e6 - LOOP_RESOLUTION_MS);
}
