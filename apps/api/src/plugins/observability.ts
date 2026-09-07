import fp from 'fastify-plugin';
import { env } from '@forge/config';
import { MetricsReporter, queueMetricSamples } from '@forge/metrics';
import { REDIS_KEYS, type MetricMessage, type ProcessMetrics } from '@forge/shared';
import type { FastifyInstance } from 'fastify';
import { API_INSTANCE } from './realtime.js';
import { HttpMetrics } from '../observability/http-metrics.js';
import { createApiMetricsSink } from '../observability/metrics-store.js';
import { readQueueStats } from '../services/fleet-service.js';
import { getRedis } from '../lib/redis.js';

/**
 * This API process's self-measurement (ROADMAP Phase 9, ARCHITECTURE §6).
 *
 * The plugin owns three things:
 *
 *  1. the HTTP timing hooks (latency, throughput, in-flight, error classes);
 *  2. the reporter that samples the process every `METRICS_INTERVAL_MS`,
 *     writes its document to Redis under a TTL and publishes samples on the
 *     `metrics` channel;
 *  3. the **election** for queue depth — see below.
 *
 * It registers after `realtime` because a metrics document for an API process
 * without its socket and Pub/Sub counts would be missing the half that is
 * specific to being the API.
 */

/**
 * Why the queue counters are elected rather than simply read:
 *
 * BullMQ's counters are a property of the queue, not of the process reading
 * them. With three API replicas each publishing `queue_waiting` on the same
 * channel, a dashboard summing what arrives charts three times the real depth
 * — and a dashboard *not* summing it charts a value that flickers between
 * three near-identical publishers. Neither is the truth.
 *
 * So one process per tick wins a short Redis lease and publishes; the others
 * publish nothing. Deliberately the same best-effort shape the worker's
 * container-stats sampler uses: no renewal, no ownership check on release,
 * because losing the election costs one skipped sample and the next tick is a
 * fresh vote. The counters are still *readable* by everyone — the REST
 * snapshot and `/metrics` read them directly. Only the stream is elected.
 */
async function winsQueueElection(ttlMs: number): Promise<boolean> {
  try {
    return (await getRedis().set(REDIS_KEYS.queueMetricsLock, API_INSTANCE, 'PX', ttlMs, 'NX')) === 'OK';
  } catch {
    // Redis is down: nobody publishes queue depth this tick, which is right —
    // the counters live in Redis, so there is nothing to publish anyway.
    return false;
  }
}

async function observabilityPlugin(app: FastifyInstance): Promise<void> {
  const http = new HttpMetrics();
  http.register(app);

  const reporter = new MetricsReporter({
    role: 'api',
    instance: API_INSTANCE,
    intervalMs: env.METRICS_INTERVAL_MS,
    sink: createApiMetricsSink(),
    log: app.log,
    extras: () => {
      const realtime = app.realtimeStats();
      return {
        api: http.snapshot({
          instance: realtime.instance,
          sockets: realtime.sockets,
          topics: realtime.topics,
          pubsub: { channels: realtime.pubsub.channels, connected: realtime.pubsub.connected },
        }),
      };
    },
    additional: async (): Promise<MetricMessage[]> => {
      // The lease is a little shorter than the interval, so the next tick is a
      // fresh election rather than a lock this process keeps forever.
      const lease = Math.max(500, env.METRICS_INTERVAL_MS - 250);
      if (!(await winsQueueElection(lease))) return [];
      const queues = await readQueueStats();
      return queueMetricSamples(queues, new Date().toISOString());
    },
  });

  reporter.start();

  app.decorate('processMetrics', (): ProcessMetrics | null => reporter.latest);

  app.addHook('onClose', async () => {
    reporter.stop();
    // Remove this process's document immediately on a clean shutdown, rather
    // than leaving the dashboard to show a dead replica until the TTL runs
    // out. The TTL is still the backstop for an unclean exit — that is the
    // case it exists for.
    try {
      await getRedis()
        .multi()
        .del(REDIS_KEYS.processMetrics('api', API_INSTANCE))
        .srem(REDIS_KEYS.metricsProcesses, `api:${API_INSTANCE}`)
        .exec();
    } catch {
      // Shutting down anyway; the TTL cleans up.
    }
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    /** This process's latest metrics document, or null before the first tick. */
    processMetrics: () => ProcessMetrics | null;
  }
}

export default fp(observabilityPlugin, { name: 'observability', dependencies: ['realtime'] });
