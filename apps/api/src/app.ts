import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { env, basePinoOptions } from '@forge/config';
import errorHandler from './plugins/error-handler.js';
import requestContext, { REQUEST_ID_HEADER } from './plugins/request-context.js';
import rateLimitPlugin from './plugins/rate-limit.js';
import authPlugin from './plugins/auth.js';
import realtimePlugin from './plugins/realtime.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { orgRoutes } from './routes/orgs.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { projectRoutes } from './routes/projects.js';
import { fileRoutes } from './routes/files.js';
import { deploymentRoutes } from './routes/deployments.js';
import { configureQueueFromEnv } from './lib/queue.js';

export const API_VERSION = '0.5.0';

export async function buildApp(): Promise<FastifyInstance> {
  // Inject REDIS_URL into @forge/queue before any route can enqueue; the queue
  // package refuses to guess a default (ARCHITECTURE §9).
  configureQueueFromEnv();

  const app = Fastify({
    logger: { ...basePinoOptions, base: { service: 'api', pid: process.pid } },
    // Trust an inbound request id (from the dashboard / proxy) so a single id
    // follows a request across processes; otherwise mint one.
    requestIdHeader: REQUEST_ID_HEADER,
    genReqId: () => randomUUID(),
    disableRequestLogging: false,
    // JSON bodies only; multipart uploads bypass this and are capped by
    // MAX_UPLOAD_BYTES in the multipart plugin below.
    bodyLimit: 1_048_576, // 1 MiB
    ajv: { customOptions: { removeAdditional: 'all' } },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // `version` is taken by Fastify itself, hence `apiVersion`.
  app.decorate('apiVersion', API_VERSION);

  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    // The dashboard is a different origin (:3000 vs :4000) and sends the
    // session cookie, so credentials must be allowed and the origin echoed.
    credentials: true,
    // @fastify/cors defaults to GET,HEAD,POST — without this every PATCH/PUT/
    // DELETE from the dashboard fails its preflight in the browser.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', REQUEST_ID_HEADER],
    // The dashboard reads the checksum and filename off a download response.
    exposedHeaders: [REQUEST_ID_HEADER, 'content-disposition', 'x-forge-sha256', 'etag'],
  });

  // Must precede the auth plugin: its onRequest hook reads request.cookies.
  await app.register(cookie);

  await app.register(multipart, {
    limits: {
      // One chunk above our own cap, so the streaming counter in
      // upload-service raises a clean 400 before multipart truncates silently.
      fileSize: env.MAX_UPLOAD_BYTES + 65_536,
      files: 1,
      fields: 10,
    },
  });

  await app.register(requestContext);
  await app.register(errorHandler);
  await app.register(rateLimitPlugin);
  await app.register(authPlugin);
  // After auth: the gateway authenticates the handshake with `request.actor`.
  await app.register(realtimePlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(orgRoutes);
  await app.register(apiKeyRoutes);
  await app.register(projectRoutes);
  await app.register(fileRoutes);
  await app.register(deploymentRoutes);

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    apiVersion: string;
  }
}
