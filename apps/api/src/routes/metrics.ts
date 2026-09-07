import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '@forge/config';
import { PROMETHEUS_CONTENT_TYPE, renderPrometheus } from '@forge/metrics';
import {
  errorResponseSchema,
  metricsQuerySchema,
  metricsSnapshotSchema,
  unauthorized,
} from '@forge/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { API_INSTANCE } from '../plugins/realtime.js';
import { getMetricsSnapshot } from '../services/metrics-service.js';

/**
 * The two observability endpoints (ROADMAP Phase 9).
 *
 *  - `GET /metrics` — Prometheus text, host-wide, unnested. Prometheus scrapes
 *    a fixed path and has no concept of our org URLs, so this is the one route
 *    in the API that is not under `/orgs/:orgId`.
 *  - `GET /orgs/:orgId/metrics` — the JSON snapshot the dashboard renders,
 *    scoped to one org so the container list and the deployment aggregates are
 *    that tenant's and nobody else's.
 *
 * Both are reads of shared state; neither touches Docker or a child process.
 */

/**
 * Whether this request may read host-wide metrics.
 *
 * Two accepted credentials, because there are two callers with incompatible
 * abilities:
 *
 *  - a **human** (or an API key) — already authenticated by the global hook,
 *    so `request.actor` is enough. The fleet page's rule applies: being a
 *    member of some org is the bar for reading infrastructure numbers.
 *  - a **scraper** — carries no cookie and cannot log in, so it presents
 *    `METRICS_TOKEN` as a bearer.
 *
 * The endpoint is *not* open. It exposes host names, pids, image-free but
 * still real deployment counts and every container's id prefix; on a laptop
 * that is harmless, and shipping an unauthenticated version of it would teach
 * exactly the wrong habit (CLAUDE.md §8: every endpoint gets authn).
 */
function mayReadMetrics(request: FastifyRequest): boolean {
  if (request.actor) return true;

  const configured = env.METRICS_TOKEN;
  if (!configured) return false;

  const header = request.headers.authorization;
  const presented = header?.toLowerCase().startsWith('bearer ')
    ? header.slice('bearer '.length).trim()
    : (request.headers['x-metrics-token'] as string | undefined);
  if (!presented) return false;

  // Constant-time: a plain `===` on a secret leaks its prefix to anyone who
  // can time the response, and this one never rotates on its own.
  const a = Buffer.from(presented);
  const b = Buffer.from(configured);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const metricsRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * The Prometheus scrape.
   *
   * No response schema: the body is `text/plain` in Prometheus's exposition
   * format, and a Zod serializer would turn it into a JSON string literal.
   * The format is produced by `@forge/metrics` and validated by the one thing
   * that matters — a scraper parsing it.
   *
   * It reports the **whole fleet**, not just this process: every process's
   * document is in Redis, and workers serve no HTTP at all, so scraping each
   * process directly is not an option here.
   */
  app.get(
    '/metrics',
    {
      // A scrape is cheap but not free — it runs three Redis reads and two
      // Postgres aggregates — so it gets its own bucket rather than sharing
      // the global one with the dashboard's polling.
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        querystring: metricsQuerySchema.partial(),
        // No `response` map at all, not even for the 401: declaring one makes
        // the type provider narrow `reply.send()` to those shapes, and this
        // route's success body is a plain string. The 401 body is produced by
        // the error-handler plugin and has the same shape as every other
        // error's regardless.
      },
    },
    async (request, reply) => {
      if (!mayReadMetrics(request)) {
        throw unauthorized(
          env.METRICS_TOKEN
            ? 'Present a session, an API key, or the metrics token as a bearer'
            : 'Log in, or set METRICS_TOKEN and present it as a bearer',
        );
      }

      const snapshot = await getMetricsSnapshot({
        orgId: null,
        windowMinutes: request.query.windowMinutes ?? env.METRICS_WINDOW_MINUTES,
        servedBy: API_INSTANCE,
        local: app.processMetrics(),
      });

      return reply.type(PROMETHEUS_CONTENT_TYPE).send(renderPrometheus(snapshot));
    },
  );

  /**
   * The dashboard's snapshot.
   *
   * Nested under the org and gated by `requireOrg` — the same rule the fleet
   * view uses. The process and queue numbers in it are infrastructure-wide
   * (there is one queue, not one per tenant), but the containers and the
   * deployment aggregates are filtered to the caller's org, which is what
   * makes serving them to a member legitimate at all.
   */
  app.get(
    '/orgs/:orgId/metrics',
    {
      preHandler: app.requireOrg,
      schema: {
        params: z.object({ orgId: z.string().min(1) }),
        querystring: metricsQuerySchema,
        response: { 200: metricsSnapshotSchema, 404: errorResponseSchema },
      },
    },
    async (request) =>
      getMetricsSnapshot({
        orgId: app.getOrg(request).orgId,
        windowMinutes: request.query.windowMinutes,
        servedBy: API_INSTANCE,
        local: app.processMetrics(),
      }),
  );
};
