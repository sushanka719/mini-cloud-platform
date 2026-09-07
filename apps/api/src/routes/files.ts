import { z } from 'zod';
import {
  artifactResultSchema,
  errorResponseSchema,
  fileListQuerySchema,
  storageUsageSchema,
  storedFileSchema,
} from '@forge/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireProject } from '../services/project-service.js';
import {
  deleteProjectFile,
  getProjectFiles,
  getStorageUsage,
  openDownload,
} from '../services/file-service.js';
import { compressProjectFile } from '../services/artifact-service.js';

const fileParams = z.object({
  orgId: z.string().min(1),
  projectId: z.string().uuid(),
  fileId: z.string().uuid(),
});
const projectParams = fileParams.omit({ fileId: true });

/**
 * The object store's HTTP surface: list what a project has stored, stream an
 * object back out, gzip one into an artifact, drop one.
 *
 * Read = any member; producing/removing objects = `member` and up.
 */
export const fileRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/orgs/:orgId/projects/:projectId/files',
    {
      preHandler: app.requireOrg,
      schema: {
        params: projectParams,
        querystring: fileListQuerySchema,
        response: { 200: z.array(storedFileSchema), 404: errorResponseSchema },
      },
    },
    async (request) => {
      const project = await requireProject(app.getOrg(request).orgId, request.params.projectId);
      return getProjectFiles(project.id, request.query.kind, request.query.limit);
    },
  );

  app.get(
    '/orgs/:orgId/projects/:projectId/storage',
    {
      preHandler: app.requireOrg,
      schema: {
        params: projectParams,
        response: { 200: storageUsageSchema, 404: errorResponseSchema },
      },
    },
    async (request) => {
      const project = await requireProject(app.getOrg(request).orgId, request.params.projectId);
      return getStorageUsage(project);
    },
  );

  /**
   * Streamed download. There is deliberately **no 200 response schema**: the
   * body is a `Readable` handed to Fastify, and giving it a schema would make
   * the serializer try to JSON-encode the stream.
   *
   * `?decompress=true` inflates a gzip artifact on the way out, so a client can
   * check the bytes it receives against `x-forge-sha256` and confirm the store
   * round-trips exactly.
   */
  app.get(
    '/orgs/:orgId/projects/:projectId/files/:fileId/download',
    {
      preHandler: app.requireOrg,
      schema: {
        params: fileParams,
        querystring: z.object({
          decompress: z
            .enum(['true', 'false'])
            .default('false')
            .transform((value) => value === 'true'),
        }),
        // Error responses are shaped by the error-handler plugin; declaring
        // them here would type `reply.send()` as "one of these objects" and
        // reject the stream.
      },
    },
    async (request, reply) => {
      const project = await requireProject(app.getOrg(request).orgId, request.params.projectId);
      const payload = await openDownload(project, request.params.fileId, {
        decompress: request.query.decompress,
      });

      if (payload.storedBytes !== Number(payload.row.size_bytes)) {
        // Not fatal — the bytes are still served — but it means the index and
        // the disk disagree, which we want in the log.
        request.log.warn(
          {
            fileId: payload.row.id,
            recordedBytes: Number(payload.row.size_bytes),
            storedBytes: payload.storedBytes,
          },
          'stored object size differs from the indexed size',
        );
      }

      reply
        .header('content-type', payload.contentType)
        .header(
          'content-disposition',
          `attachment; filename="${payload.filename}"; filename*=UTF-8''${encodeURIComponent(payload.filename)}`,
        )
        // Objects are per-org and behind auth; never let a proxy keep a copy.
        .header('cache-control', 'private, no-store');

      if (payload.contentLength !== null) {
        reply.header('content-length', String(payload.contentLength));
      }
      if (payload.checksum) {
        reply.header('x-forge-sha256', payload.checksum).header('etag', `"${payload.checksum}"`);
      }

      request.log.info(
        {
          fileId: payload.row.id,
          kind: payload.row.kind,
          decompressed: payload.decompressed,
          bytes: payload.contentLength,
        },
        'streaming object download',
      );

      return reply.send(payload.stream);
    },
  );

  app.post(
    '/orgs/:orgId/projects/:projectId/files/:fileId/compress',
    {
      preHandler: app.requireRole('member'),
      // Each call pins a worker thread for the duration; keep a lid on it.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        params: fileParams,
        response: {
          201: artifactResultSchema,
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const project = await requireProject(app.getOrg(request).orgId, request.params.projectId);
      const result = await compressProjectFile(project, request.params.fileId);

      request.log.info(
        {
          projectId: project.id,
          sourceFileId: request.params.fileId,
          artifactFileId: result.file.id,
          bytesIn: result.file.uncompressedBytes,
          bytesOut: result.file.sizeBytes,
          ratio: Number(result.ratio.toFixed(4)),
          durationMs: result.durationMs,
          threadId: result.threadId,
        },
        'artifact compressed on a worker thread',
      );
      return reply.status(201).send(result);
    },
  );

  app.delete(
    '/orgs/:orgId/projects/:projectId/files/:fileId',
    {
      preHandler: app.requireRole('member'),
      schema: {
        params: fileParams,
        response: { 204: z.null(), 403: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const project = await requireProject(app.getOrg(request).orgId, request.params.projectId);
      const { objectDeleted } = await deleteProjectFile(project, request.params.fileId);
      request.log.info(
        { projectId: project.id, fileId: request.params.fileId, objectDeleted },
        'stored object deleted',
      );
      return reply.status(204).send(null);
    },
  );
};
