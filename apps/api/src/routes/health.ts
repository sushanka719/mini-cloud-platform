import { z } from 'zod';
import { healthResponseSchema } from '@forge/shared';
import { getHealth } from '../services/health-service.js';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  // Liveness: is this process up? Deliberately touches no dependency.
  app.get(
    '/health/live',
    {
      schema: {
        response: { 200: z.object({ ok: z.literal(true), pid: z.number().int() }) },
      },
    },
    async () => ({ ok: true as const, pid: process.pid }),
  );

  // Readiness/health: 200 only when Postgres and Redis both answer. Both paths
  // return the same body so the dashboard can render *why* it is unhealthy.
  const healthSchema = {
    response: { 200: healthResponseSchema, 503: healthResponseSchema },
  } as const;

  app.get('/health', { schema: healthSchema }, async (_request, reply) => {
    const health = await getHealth(app.apiVersion);
    return reply.status(health.ok ? 200 : 503).send(health);
  });

  app.get('/health/ready', { schema: healthSchema }, async (_request, reply) => {
    const health = await getHealth(app.apiVersion);
    return reply.status(health.ok ? 200 : 503).send(health);
  });
};
