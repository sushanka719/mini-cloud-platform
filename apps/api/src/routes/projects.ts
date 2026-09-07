import { z } from 'zod';
import {
  bulkEnvVarsSchema,
  createProjectSchema,
  envVarKeySchema,
  envVarSchema,
  errorResponseSchema,
  projectSchema,
  storedFileSchema,
  updateProjectSchema,
  upsertEnvVarSchema,
  badRequest,
} from '@forge/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { fileRepo } from '@forge/db';
import {
  createProject,
  editProject,
  getProject,
  getProjects,
  removeProject,
  requireProject,
} from '../services/project-service.js';
import {
  getEnvVars,
  removeEnvVar,
  setEnvVar,
  setEnvVars,
} from '../services/env-var-service.js';
import { storeProjectSource } from '../services/upload-service.js';
import { toStoredFile } from '../services/serializers.js';

const projectParams = z.object({ orgId: z.string().min(1), projectId: z.string().uuid() });
const envVarParams = projectParams.extend({ key: envVarKeySchema });

/**
 * Read = any member. Write = `member` and up. Deleting a project = `admin`.
 * Env var writes are `member` too: setting config is normal day-to-day work,
 * but a `viewer` must not be able to change what a deployment runs with.
 */
export const projectRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/orgs/:orgId/projects',
    {
      preHandler: app.requireOrg,
      schema: {
        params: z.object({ orgId: z.string().min(1) }),
        response: { 200: z.array(projectSchema), 404: errorResponseSchema },
      },
    },
    async (request) => getProjects(app.getOrg(request).orgId),
  );

  app.post(
    '/orgs/:orgId/projects',
    {
      preHandler: app.requireRole('member'),
      schema: {
        params: z.object({ orgId: z.string().min(1) }),
        body: createProjectSchema,
        response: {
          201: projectSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const org = app.getOrg(request);
      const actor = app.getActor(request);
      const project = await createProject(org.orgId, actor.user.id, request.body);
      request.log.info({ orgId: org.orgId, projectId: project.id }, 'project created');
      return reply.status(201).send(project);
    },
  );

  app.get(
    '/orgs/:orgId/projects/:projectId',
    {
      preHandler: app.requireOrg,
      schema: {
        params: projectParams,
        response: { 200: projectSchema, 404: errorResponseSchema },
      },
    },
    async (request) => getProject(app.getOrg(request).orgId, request.params.projectId),
  );

  app.patch(
    '/orgs/:orgId/projects/:projectId',
    {
      preHandler: app.requireRole('member'),
      schema: {
        params: projectParams,
        body: updateProjectSchema,
        response: { 200: projectSchema, 403: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) =>
      editProject(app.getOrg(request).orgId, request.params.projectId, request.body),
  );

  app.delete(
    '/orgs/:orgId/projects/:projectId',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        params: projectParams,
        response: { 204: z.null(), 403: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const org = app.getOrg(request);
      await removeProject(org.orgId, request.params.projectId);
      request.log.info({ orgId: org.orgId, projectId: request.params.projectId }, 'project deleted');
      return reply.status(204).send(null);
    },
  );

  // --- env vars -------------------------------------------------------------

  app.get(
    '/orgs/:orgId/projects/:projectId/env',
    {
      preHandler: app.requireOrg,
      schema: {
        params: projectParams,
        // `value` is null for every secret — see env-var-service.
        response: { 200: z.array(envVarSchema), 404: errorResponseSchema },
      },
    },
    async (request) => {
      const project = await requireProject(app.getOrg(request).orgId, request.params.projectId);
      return getEnvVars(project.id);
    },
  );

  app.put(
    '/orgs/:orgId/projects/:projectId/env',
    {
      preHandler: app.requireRole('member'),
      schema: {
        params: projectParams,
        body: upsertEnvVarSchema,
        response: { 200: envVarSchema, 403: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => {
      const project = await requireProject(app.getOrg(request).orgId, request.params.projectId);
      const saved = await setEnvVar(project.id, request.body);
      // Log the key, never the value.
      request.log.info({ projectId: project.id, key: saved.key }, 'env var set');
      return saved;
    },
  );

  app.put(
    '/orgs/:orgId/projects/:projectId/env/bulk',
    {
      preHandler: app.requireRole('member'),
      schema: {
        params: projectParams,
        body: bulkEnvVarsSchema,
        response: {
          200: z.array(envVarSchema),
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const project = await requireProject(app.getOrg(request).orgId, request.params.projectId);
      const keys = request.body.vars.map((v) => v.key);
      if (new Set(keys).size !== keys.length) {
        throw badRequest('DUPLICATE_ENV_KEY', 'The same key appears more than once');
      }
      const saved = await setEnvVars(project.id, request.body.vars);
      request.log.info({ projectId: project.id, count: saved.length }, 'env vars set in bulk');
      return saved;
    },
  );

  app.delete(
    '/orgs/:orgId/projects/:projectId/env/:key',
    {
      preHandler: app.requireRole('member'),
      schema: {
        params: envVarParams,
        response: { 204: z.null(), 403: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const project = await requireProject(app.getOrg(request).orgId, request.params.projectId);
      await removeEnvVar(project.id, request.params.key);
      return reply.status(204).send(null);
    },
  );

  // --- source upload --------------------------------------------------------

  app.post(
    '/orgs/:orgId/projects/:projectId/source',
    {
      preHandler: app.requireRole('member'),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        params: projectParams,
        // No `body` schema: the payload is multipart and consumed as a stream,
        // so there is nothing for the Zod validator to parse.
        response: {
          201: storedFileSchema,
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          413: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const project = await requireProject(app.getOrg(request).orgId, request.params.projectId);

      const part = await request.file();
      if (!part) throw badRequest('NO_FILE', 'Expected a multipart file field named "file"');

      const result = await storeProjectSource(project, {
        stream: part.file,
        filename: part.filename,
        mimetype: part.mimetype,
        // Backstop: our HashingCounter normally trips first (multipart's own
        // limit is set one chunk higher), but a silent truncation must not be
        // recorded as a complete source.
        isTruncated: () => part.file.truncated,
      });

      request.log.info(
        {
          projectId: project.id,
          fileId: result.file.id,
          sizeBytes: result.sizeBytes,
          checksum: result.checksum,
        },
        'project source uploaded',
      );
      return reply.status(201).send(result.file);
    },
  );

  app.get(
    '/orgs/:orgId/projects/:projectId/source',
    {
      preHandler: app.requireOrg,
      schema: {
        params: projectParams,
        response: { 200: z.array(storedFileSchema), 404: errorResponseSchema },
      },
    },
    async (request) => {
      const project = await requireProject(app.getOrg(request).orgId, request.params.projectId);
      return (await fileRepo.listProjectFiles(project.id, 'source')).map(toStoredFile);
    },
  );
};
