import { performance } from 'node:perf_hooks';
import { LatencyWindow } from '@forge/metrics';
import { env } from '@forge/config';
import { round, type ApiRuntimeMetrics } from '@forge/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Request latency and throughput for this API process (ARCHITECTURE §6:
 * "latency — request timing via a Fastify hook").
 *
 * Per-process by definition, and that is fine: it is a property of *this*
 * replica's event loop, and the metrics document it ends up in is keyed by
 * instance. Aggregating across replicas is the reader's job (or Prometheus's),
 * not something to fake here by writing a shared counter — which would also
 * put a Redis round trip on every request.
 *
 * Timing comes from Fastify's own `reply.elapsedTime` rather than a hook-local
 * `performance.now()` pair: it is measured from the moment the request was
 * received, so it includes the body parse and every preHandler, which a hook
 * that starts its own clock in `onRequest` would miss.
 */
export class HttpMetrics {
  readonly #latency: LatencyWindow;
  #inflight = 0;
  #lastDrainAt = performance.now();

  constructor(samples = env.METRICS_LATENCY_SAMPLES) {
    this.#latency = new LatencyWindow(samples);
  }

  get inflight(): number {
    return this.#inflight;
  }

  /**
   * Registers the hooks.
   *
   * `onRequestAbort` matters more than it looks: without it a client that
   * disconnects mid-request never reaches `onResponse`, and the in-flight
   * gauge climbs forever — the classic way a "requests in flight" number
   * becomes a lie that suggests a leak that isn't there.
   */
  register(app: FastifyInstance): void {
    app.addHook('onRequest', async () => {
      this.#inflight += 1;
    });
    app.addHook('onResponse', async (_request: FastifyRequest, reply: FastifyReply) => {
      this.#inflight = Math.max(0, this.#inflight - 1);
      this.#latency.record(reply.elapsedTime, reply.statusCode);
    });
    // The parameter is unused but required: Fastify validates an async
    // `onRequestAbort` hook as having *exactly* one argument (its callback
    // form is `(request, done)`), and rejects a zero-arg async function at
    // boot with FST_ERR_HOOK_INVALID_ASYNC_HANDLER.
    app.addHook('onRequestAbort', async (_request: FastifyRequest) => {
      this.#inflight = Math.max(0, this.#inflight - 1);
    });
  }

  /**
   * The API half of a metrics document, and the end of a reporting interval.
   *
   * Called once per tick by the reporter, so the counters it drains describe
   * exactly one interval — which is what makes `requestsPerSecond` a rate
   * rather than a lifetime average.
   */
  snapshot(realtime: {
    instance: string;
    sockets: number;
    topics: number;
    pubsub: { channels: number; connected: boolean };
  }): ApiRuntimeMetrics {
    const now = performance.now();
    const elapsedMs = Math.max(1, now - this.#lastDrainAt);
    this.#lastDrainAt = now;

    const counters = this.#latency.drainCounters();
    const latency = this.#latency.stats();

    return {
      sockets: realtime.sockets,
      topics: realtime.topics,
      pubsubChannels: realtime.pubsub.channels,
      pubsubConnected: realtime.pubsub.connected,
      requests: counters.total,
      requestsPerSecond: round(counters.total / (elapsedMs / 1000), 2),
      inflight: this.#inflight,
      serverErrors: counters.serverErrors,
      clientErrors: counters.clientErrors,
      latencyMs: {
        p50: round(latency.p50 ?? 0, 2),
        p95: round(latency.p95 ?? 0, 2),
        max: round(latency.max ?? 0, 2),
      },
    };
  }
}
