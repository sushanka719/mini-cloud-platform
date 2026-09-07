import { z } from 'zod';
import {
  createDeploymentSchema,
  deploymentEventSchema,
  deploymentEventsQuerySchema,
  deploymentListQuerySchema,
  deploymentSchema,
  errorResponseSchema,
  fleetSchema,
} from '@forge/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireProject } from '../services/project-service.js';
import {
  createDeployment,
  getDeployment,
  getDeploymentEvents,
  getDeployments,
  getOrgDeployments,
} from '../services/deployment-service.js';
import { getFleet } from '../services/fleet-service.js';

const projectParams = z.object({ orgId: z.string().min(1), projectId: z.string().uuid() });
const deploymentParams = projectParams.extend({ deploymentId: z.string().uuid() });

/**
 * Deployments are nested under the project so RBAC is the same one-line check
 * as everywhere else (the roadmap wrote it as a bare `POST /deployments`).
 *
 * Read = any member. Triggering a deployment = `member`: it runs code and
 * consumes resources, so a `viewer` must not be able to start one.
 */
export const deploymentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/orgs/:orgId/projects/:projectId/deployments',
    {
      preHandler: app.requireRole('member'),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        params: projectParams,
        body: createDeploymentSchema,
        response: {
          // 202: accepted, a worker will pick it up.
          202: deploymentSchema,
          // 200: idempotency replay — this is the deployment you already made.
          200: deploymentSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const org = app.getOrg(request);
      const actor = app.getActor(request);
      const project = await requireProject(org.orgId, request.params.projectId);

      const { deployment, created } = await createDeployment(
        project,
        actor.user.id,
        request.body,
      );

      request.log.info(
        {
          projectId: project.id,
          deploymentId: deployment.id,
          created,
          sourceRef: deployment.sourceRef,
        },
        created ? 'deployment queued' : 'deployment idempotency replay',
      );

      return reply.status(created ? 202 : 200).send(deployment);
    },
  );

  app.get(
    '/orgs/:orgId/projects/:projectId/deployments',
    {
      preHandler: app.requireOrg,
      schema: {
        params: projectParams,
        querystring: deploymentListQuerySchema,
        response: { 200: z.array(deploymentSchema), 404: errorResponseSchema },
      },
    },
    async (request) => {
      const project = await requireProject(app.getOrg(request).orgId, request.params.projectId);
      return getDeployments(project.id, request.query);
    },
  );

  app.get(
    '/orgs/:orgId/projects/:projectId/deployments/:deploymentId',
    {
      preHandler: app.requireOrg,
      schema: {
        params: deploymentParams,
        response: { 200: deploymentSchema, 404: errorResponseSchema },
      },
    },
    async (request) => {
      const project = await requireProject(app.getOrg(request).orgId, request.params.projectId);
      return getDeployment(project.id, request.params.deploymentId);
    },
  );

  /**
   * The append-only timeline. `afterId` is the replay cursor the Phase 5
   * WebSocket will use on reconnect; polling the dashboard uses it too, so a
   * refresh doesn't re-read the whole history.
   */
  app.get(
    '/orgs/:orgId/projects/:projectId/deployments/:deploymentId/events',
    {
      preHandler: app.requireOrg,
      schema: {
        params: deploymentParams,
        querystring: deploymentEventsQuerySchema,
        response: { 200: z.array(deploymentEventSchema), 404: errorResponseSchema },
      },
    },
    async (request) => {
      const project = await requireProject(app.getOrg(request).orgId, request.params.projectId);
      const { afterId, limit } = request.query;
      return getDeploymentEvents(project.id, request.params.deploymentId, {
        ...(afterId !== undefined ? { afterId } : {}),
        limit,
      });
    },
  );

  // --- org-level views ------------------------------------------------------

  app.get(
    '/orgs/:orgId/deployments',
    {
      preHandler: app.requireOrg,
      schema: {
        params: z.object({ orgId: z.string().min(1) }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
        response: { 200: z.array(deploymentSchema), 404: errorResponseSchema },
      },
    },
    async (request) => getOrgDeployments(app.getOrg(request).orgId, request.query.limit),
  );

  /**
   * Queue depth + worker fleet. Infrastructure is global rather than
   * org-scoped, but the route is nested so authorization stays one rule: you
   * must be a member of *some* org you can name to see it.
   */
  app.get(
    '/orgs/:orgId/fleet',
    {
      preHandler: app.requireOrg,
      schema: {
        params: z.object({ orgId: z.string().min(1) }),
        response: { 200: fleetSchema, 404: errorResponseSchema },
      },
    },
    async () => getFleet(),
  );
};
