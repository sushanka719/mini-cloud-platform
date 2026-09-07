import {
  REDIS_CHANNELS,
  REDIS_KEYS,
  parseProcessScope,
  processMetricsSchema,
  processScope,
  type MetricMessage,
  type ProcessMetrics,
} from '@forge/shared';
import { env } from '@forge/config';
import type { MetricsSink } from '@forge/metrics';
import { getPublisherRedis, getRedis } from '../lib/redis.js';

/**
 * Process metrics as shared state.
 *
 * Two Redis structures, and the split is the whole design:
 *
 *  - `metrics:process:<role>:<instance>` — one JSON document per process,
 *    **with a TTL**. The TTL is the liveness signal, exactly as it is for
 *    worker heartbeats: a process killed with SIGKILL cannot write "I am
 *    gone", but its key expires on its own. Nothing has to reap it.
 *  - `metrics:processes` — a set of `<role>:<instance>` ids, because Redis has
 *    no "list keys matching a pattern" that is safe to run on a request path
 *    (`KEYS` is O(n) and blocking; `SCAN` is several round trips and still
 *    misses concurrent writes). The set is the index; the documents' TTLs
 *    decide which entries are real, and a reader prunes the ones that are not.
 *
 * The consequence worth stating: **any** API replica can render the whole
 * fleet — every other replica and every worker — because none of it is in
 * process memory (CLAUDE.md §4).
 */

/**
 * The API's own sink, handed to `MetricsReporter`.
 *
 * Two connections on purpose: the document goes over the command connection
 * (it is state, and a lost write means a gap on the dashboard), the samples
 * over the publisher connection, which has ioredis's offline queue disabled so
 * a publish during a Redis reconnect fails instantly instead of queueing a
 * few hundred stale frames to deliver later.
 */
export function createApiMetricsSink(): MetricsSink {
  return {
    store: (metrics) => storeProcessMetrics(metrics),
    publish: (samples) => publishMetrics(samples),
  };
}

export async function storeProcessMetrics(metrics: ProcessMetrics): Promise<void> {
  const id = processScope(metrics.role, metrics.instance);
  await getRedis()
    .multi()
    .set(
      REDIS_KEYS.processMetrics(metrics.role, metrics.instance),
      JSON.stringify(metrics),
      'EX',
      env.METRICS_TTL_SECONDS,
    )
    .sadd(REDIS_KEYS.metricsProcesses, id)
    .exec();
}

/**
 * Publishes samples on the global `metrics` channel.
 *
 * One pipeline rather than N awaited publishes: a tick emits a dozen frames
 * and a round trip each would make the reporter's own cost visible in the
 * numbers it reports.
 */
export async function publishMetrics(samples: readonly MetricMessage[]): Promise<void> {
  if (samples.length === 0) return;
  const pipeline = getPublisherRedis().pipeline();
  for (const sample of samples) {
    pipeline.publish(REDIS_CHANNELS.metrics, JSON.stringify(sample));
  }
  await pipeline.exec();
}

/**
 * Every process currently reporting, newest-registered order irrelevant.
 *
 * Sorted by role then instance so the dashboard's cards don't reshuffle on
 * every poll — Redis set iteration order is not stable, and a list of process
 * cards that jumps around is unreadable during a live demo.
 *
 * A document that has expired but whose id is still in the index is pruned
 * here. That makes the reader responsible for cleanup, which is right: the
 * writer is by definition gone.
 */
export async function readFleetMetrics(): Promise<ProcessMetrics[]> {
  const redis = getRedis();
  const ids = await redis.smembers(REDIS_KEYS.metricsProcesses);
  if (ids.length === 0) return [];

  const keys: string[] = [];
  const valid: string[] = [];
  const malformed: string[] = [];
  for (const id of ids) {
    const parsed = parseProcessScope(id);
    if (!parsed) {
      malformed.push(id);
      continue;
    }
    valid.push(id);
    keys.push(REDIS_KEYS.processMetrics(parsed.role, parsed.instance));
  }

  const raw = keys.length > 0 ? await redis.mget(...keys) : [];
  const processes: ProcessMetrics[] = [];
  const stale: string[] = [...malformed];

  raw.forEach((value, index) => {
    const id = valid[index];
    if (id === undefined) return;
    if (value === null) {
      stale.push(id);
      return;
    }
    const parsed = safeParse(value);
    // A document that fails validation was written by an older process; it is
    // ignored rather than rendered, and left in the index for its own writer
    // to overwrite — dropping the id would only make it come back next tick.
    if (parsed) processes.push(parsed);
  });

  if (stale.length > 0) {
    // Best-effort: a failed prune costs one wasted MGET slot next time.
    void redis.srem(REDIS_KEYS.metricsProcesses, ...stale).catch(() => undefined);
  }

  return processes.sort(
    (a, b) => a.role.localeCompare(b.role) || a.instance.localeCompare(b.instance),
  );
}

function safeParse(raw: string): ProcessMetrics | null {
  try {
    const parsed = processMetricsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
