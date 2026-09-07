import {
  REDIS_CHANNELS,
  REDIS_KEYS,
  processScope,
  type ContainerStats,
  type MetricMessage,
  type ProcessMetrics,
} from '@forge/shared';
import { env } from '@forge/config';
import { containerMetricSamples, type MetricsSink } from '@forge/metrics';
import { getPublisher, getRedis } from '../lib/redis.js';

/**
 * How a worker publishes what it measures.
 *
 * The worker serves no HTTP, so it has no `/metrics` of its own — Redis is the
 * only way its numbers reach anybody. That makes this module the *entire*
 * observability surface of a worker process, and the reason the API's
 * `/metrics` reports the whole fleet rather than just itself.
 *
 * Two connections, matching the API's split: the document over the command
 * connection (it is state), the samples over the publisher connection, whose
 * offline queue is disabled so a publish during a Redis reconnect fails
 * instantly instead of replaying stale frames minutes later.
 */

export function createWorkerMetricsSink(): MetricsSink {
  return {
    store: async (metrics: ProcessMetrics) => {
      await getRedis()
        .multi()
        .set(
          REDIS_KEYS.processMetrics(metrics.role, metrics.instance),
          JSON.stringify(metrics),
          'EX',
          env.METRICS_TTL_SECONDS,
        )
        .sadd(REDIS_KEYS.metricsProcesses, processScope(metrics.role, metrics.instance))
        .exec();
    },
    publish: async (samples: readonly MetricMessage[]) => {
      if (samples.length === 0) return;
      const pipeline = getPublisher().pipeline();
      for (const sample of samples) {
        pipeline.publish(REDIS_CHANNELS.metrics, JSON.stringify(sample));
      }
      await pipeline.exec();
    },
  };
}

/**
 * Publishes one container's sample on the **tenant-scoped** channels.
 *
 * Deliberately not on the global `metrics` channel. A container belongs to one
 * org, `metrics` is readable by any authenticated member (`authorizeTopic`
 * treats it as infrastructure-wide, like `GET …/fleet`), and putting a
 * customer's CPU trace there would be a cross-tenant leak dressed up as a
 * chart. The three channels used instead — `deployment:<id>`, `project:<id>`,
 * `org:<id>` — are exactly the ones whose subscriptions are already authorized
 * per tenant, and they are the same three a status transition is published on,
 * so the dashboard's existing subscriptions pick these up with no new topic.
 *
 * Best-effort, like every other publish in the pipeline: the durable answer is
 * the stats document in Redis, which the containers view reads over REST.
 */
export async function publishContainerMetrics(
  stats: ContainerStats,
  projectId: string,
  orgId: string,
): Promise<void> {
  const samples = containerMetricSamples(stats);
  try {
    const pipeline = getPublisher().pipeline();
    for (const sample of samples) {
      const body = JSON.stringify(sample);
      pipeline.publish(REDIS_CHANNELS.deployment(stats.deploymentId), body);
      pipeline.publish(REDIS_CHANNELS.project(projectId), body);
      pipeline.publish(REDIS_CHANNELS.org(orgId), body);
    }
    await pipeline.exec();
  } catch {
    // Swallowed — see above.
  }
}

/**
 * Drops this worker's metrics document on a clean shutdown.
 *
 * The TTL would do it within seconds anyway; this only makes the dashboard
 * truthful *immediately* when a worker is stopped on purpose, which is the
 * case someone is watching during the scaling demo.
 */
export async function forgetProcessMetrics(instance: string): Promise<void> {
  try {
    await getRedis()
      .multi()
      .del(REDIS_KEYS.processMetrics('worker', instance))
      .srem(REDIS_KEYS.metricsProcesses, processScope('worker', instance))
      .exec();
  } catch {
    // Shutting down; the TTL is the backstop.
  }
}
