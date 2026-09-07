import { z } from 'zod';
import {
  containerActionResultSchema,
  containerSummarySchema,
  createDeploymentSchema,
  createRollbackSchema,
  deadLetterEntrySchema,
  deploymentEventSchema,
  deploymentEventsQuerySchema,
  deploymentListQuerySchema,
  deploymentSchema,
  errorResponseSchema,
  fleetSchema,
  retryResultSchema,
  rollbackTargetSchema,
  storedFileSchema,
} from '@forge/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireProject } from '../services/project-service.js';
import {
  createDeployment,
  discardOrgDeadLetter,
  getDeployment,
  getDeploymentEvents,
  getDeploymentFiles,
  getDeployments,
  getOrgDeadLetters,
  getOrgDeployments,
  getWorkerDeployments,
  getRollbackTargets,
  retryDeployment,
  rollbackToDeployment,
} from '../services/deployment-service.js';
import { getFleet } from '../services/fleet-service.js';
import { getOrgContainers, requestContainerAction } from '../services/container-service.js';

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

  /**
   * Objects this deployment produced — the stored build log, and from Phase 7
   * the artifact. The bytes come back through the existing
   * `/files/:fileId/download` route, so there is one streaming download path
   * in the API rather than two.
   */
  app.get(
    '/orgs/:orgId/projects/:projectId/deployments/:deploymentId/files',
    {
      preHandler: app.requireOrg,
      schema: {
        params: deploymentParams,
        response: { 200: z.array(storedFileSchema), 404: errorResponseSchema },
      },
    },
    async (request) => {
      const project = await requireProject(app.getOrg(request).orgId, request.params.projectId);
      return getDeploymentFiles(project.id, request.params.deploymentId);
    },
  );

  /**
   * Stop / restart a running deployment.
   *
   * Both are `202`, not `200`: the API cannot touch Docker (ARCHITECTURE §9),
   * so it validates the request and enqueues it on `container-actions`. The
   * transition the user is waiting for is written by the worker that executes
   * it and arrives over the WebSocket, exactly like a deployment's stages do.
   *
   * `member`, not `admin`: stopping is the inverse of deploying and the same
   * people should be able to do both. A `viewer` can see the URL, not pull it
   * down.
   */
  for (const action of ['stop', 'restart'] as const) {
    app.post(
      `/orgs/:orgId/projects/:projectId/deployments/:deploymentId/${action}`,
      {
        preHandler: app.requireRole('member'),
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
        schema: {
          params: deploymentParams,
          response: {
            202: containerActionResultSchema,
            // 200: nothing to do — already stopped, no container. Not a 409:
            // a double-click on Stop has got what it asked for.
            200: containerActionResultSchema,
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

        const result = await requestContainerAction(
          project.id,
          request.params.deploymentId,
          action,
          actor.user.id,
        );
        request.log.info(
          { projectId: project.id, deploymentId: result.deploymentId, action, enqueued: result.enqueued },
          'container action requested',
        );
        return reply.status(result.enqueued ? 202 : 200).send(result);
      },
    );
  }

  /**
   * Retry a failed deployment — the manual half of Phase 8's retry story.
   *
   * `202` when a run was queued, `200` when there was nothing to do (already
   * running, already live, not failed). Not a 409: a double-clicked Retry has
   * got what it asked for, and the second click should not look like an error.
   *
   * `member`, like Deploy: a retry runs code and consumes resources.
   */
  app.post(
    '/orgs/:orgId/projects/:projectId/deployments/:deploymentId/retry',
    {
      preHandler: app.requireRole('member'),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        params: deploymentParams,
        response: {
          202: retryResultSchema,
          200: retryResultSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const project = await requireProject(app.getOrg(request).orgId, request.params.projectId);
      const result = await retryDeployment(project, request.params.deploymentId);
      request.log.info(
        {
          projectId: project.id,
          deploymentId: result.deploymentId,
          enqueued: result.enqueued,
          attempt: result.attempt,
        },
        'deployment retry requested',
      );
      return reply.status(result.enqueued ? 202 : 200).send(result);
    },
  );

  /**
   * Deployments this project can be rolled back to.
   *
   * Read-only and any member: knowing which versions exist is not a privilege,
   * and the dashboard needs the list to render the Rollback menu before anyone
   * has the right to use it.
   */
  app.get(
    '/orgs/:orgId/projects/:projectId/rollback-targets',
    {
      preHandler: app.requireOrg,
      schema: {
        params: projectParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }),
        response: { 200: z.array(rollbackTargetSchema), 404: errorResponseSchema },
      },
    },
    async (request) => {
      const project = await requireProject(app.getOrg(request).orgId, request.params.projectId);
      return getRollbackTargets(project.id, request.query.limit);
    },
  );

  /**
   * Roll the project back **to** this deployment.
   *
   * The target is the path parameter and the result is a *new* deployment, so
   * this reads as "make this one current again" rather than "undo the current
   * one" — which matters, because a project may have several deployments back
   * and only the person clicking knows which one was good.
   *
   * `202` always when accepted: like a deploy, the API records the intent and a
   * worker does the work. `200` is the idempotency replay.
   */
  app.post(
    '/orgs/:orgId/projects/:projectId/deployments/:deploymentId/rollback',
    {
      preHandler: app.requireRole('member'),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        params: deploymentParams,
        body: createRollbackSchema,
        response: {
          202: deploymentSchema,
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

      const { deployment, created } = await rollbackToDeployment(
        project,
        request.params.deploymentId,
        actor.user.id,
        request.body,
      );
      request.log.info(
        {
          projectId: project.id,
          deploymentId: deployment.id,
          rollbackTo: request.params.deploymentId,
          created,
        },
        created ? 'rollback queued' : 'rollback idempotency replay',
      );
      return reply.status(created ? 202 : 200).send(deployment);
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

  /** This org's deployments that ran on one worker — "who built what". */
  app.get(
    '/orgs/:orgId/workers/:workerId/deployments',
    {
      preHandler: app.requireOrg,
      schema: {
        params: z.object({ orgId: z.string().min(1), workerId: z.string().uuid() }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
        response: { 200: z.array(deploymentSchema), 404: errorResponseSchema },
      },
    },
    async (request) =>
      getWorkerDeployments(
        app.getOrg(request).orgId,
        request.params.workerId,
        request.query.limit,
      ),
  );

  /**
   * Every container this org has running.
   *
   * Postgres says what should be running; Redis supplies the CPU/memory
   * samples a worker's container monitor wrote. Neither read touches Docker,
   * which is what keeps this route legal for the API to serve at all.
   */
  app.get(
    '/orgs/:orgId/containers',
    {
      preHandler: app.requireOrg,
      schema: {
        params: z.object({ orgId: z.string().min(1) }),
        response: { 200: z.array(containerSummarySchema), 404: errorResponseSchema },
      },
    },
    async (request) => getOrgContainers(app.getOrg(request).orgId),
  );

  /**
   * Deployments whose retry budget ran out, parked in `deployments-dlq`.
   *
   * Org-scoped in the *service*, not the queue: BullMQ holds every tenant's
   * entries in one list, so the filter is applied in process. That is the whole
   * reason this is not simply "list the queue".
   */
  app.get(
    '/orgs/:orgId/dead-letters',
    {
      preHandler: app.requireOrg,
      schema: {
        params: z.object({ orgId: z.string().min(1) }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
        response: {
          200: z.array(deadLetterEntrySchema),
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => getOrgDeadLetters(app.getOrg(request).orgId, request.query.limit),
  );

  /**
   * Discards one parked entry — "I have dealt with this".
   *
   * `admin`, unlike the read: throwing away the record of a failure is not
   * something a member should be able to do quietly, and the entry is the only
   * durable copy of the reason once the deployment row has been retried.
   */
  app.delete(
    '/orgs/:orgId/dead-letters/:jobId',
    {
      preHandler: app.requireRole('admin'),
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        params: z.object({ orgId: z.string().min(1), jobId: z.string().min(1).max(200) }),
        response: {
          204: z.null(),
          403: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await discardOrgDeadLetter(app.getOrg(request).orgId, request.params.jobId);
      request.log.info({ jobId: request.params.jobId }, 'dead-letter entry discarded');
      return reply.status(204).send(null);
    },
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
