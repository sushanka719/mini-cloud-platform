import { meanOf, percentileOf } from '@forge/shared';

/**
 * A fixed-size ring of the most recent latency samples.
 *
 * Bounded because it is fed by every HTTP request: an unbounded array is a
 * memory leak with a percentile function attached. A ring rather than "clear
 * on read" so a percentile still has samples to work with when a tick lands
 * during an idle second.
 *
 * Deliberately *not* a histogram with fixed buckets. Buckets are the right
 * answer at scale and the wrong one here: we want an exact p95 over a few
 * hundred samples, and a bucketed p95 on a laptop demo would be a rounded
 * approximation of a number small enough to read exactly.
 */
export class LatencyWindow {
  readonly #samples: number[];
  #next = 0;
  #size = 0;
  /** Counters since the last `drainCounters()` — i.e. per reporting interval. */
  #total = 0;
  #clientErrors = 0;
  #serverErrors = 0;

  constructor(private readonly capacity = 512) {
    this.#samples = new Array<number>(capacity).fill(0);
  }

  /** Records one completed request. `status` classifies it as 4xx/5xx. */
  record(durationMs: number, status: number): void {
    this.#samples[this.#next] = durationMs;
    this.#next = (this.#next + 1) % this.capacity;
    if (this.#size < this.capacity) this.#size += 1;
    this.#total += 1;
    if (status >= 500) this.#serverErrors += 1;
    else if (status >= 400) this.#clientErrors += 1;
  }

  /** Percentiles over the retained window. null when nothing is retained. */
  stats(): { p50: number | null; p95: number | null; max: number | null; mean: number | null } {
    const values = this.#samples.slice(0, this.#size);
    return {
      p50: percentileOf(values, 50),
      p95: percentileOf(values, 95),
      max: values.length === 0 ? null : Math.max(...values),
      mean: meanOf(values),
    };
  }

  /**
   * Returns the counters for the interval just ended and resets them.
   *
   * Counters reset while the latency ring does not: "requests in the last two
   * seconds" is a rate and has to be per-interval, whereas "p95 latency" is a
   * distribution and reads better over a slightly longer window than one tick.
   */
  drainCounters(): { total: number; clientErrors: number; serverErrors: number } {
    const drained = {
      total: this.#total,
      clientErrors: this.#clientErrors,
      serverErrors: this.#serverErrors,
    };
    this.#total = 0;
    this.#clientErrors = 0;
    this.#serverErrors = 0;
    return drained;
  }
}
