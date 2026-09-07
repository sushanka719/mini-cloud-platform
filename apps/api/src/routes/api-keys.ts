import { z } from 'zod';
import {
  apiKeySchema,
  createApiKeySchema,
  createdApiKeySchema,
  errorResponseSchema,
  forbidden,
} from '@forge/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { createApiKey, getApiKeys, revoke } from '../services/api-key-service.js';

const orgParams = z.object({ orgId: z.string().min(1) });
const keyParams = orgParams.extend({ keyId: z.string().uuid() });

export const apiKeyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/orgs/:orgId/api-keys',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        params: orgParams,
        // Only ever the prefix and metadata — `key_hash` has no serializer.
        response: { 200: z.array(apiKeySchema), 403: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => getApiKeys(app.getOrg(request).orgId),
  );

  app.post(
    '/orgs/:orgId/api-keys',
    {
      preHandler: app.requireRole('admin'),
      // Minting a credential is worth a tighter bucket than ordinary writes.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        params: orgParams,
        body: createApiKeySchema,
        // The one response in the API that contains a plaintext credential.
        response: {
          201: createdApiKeySchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const org = app.getOrg(request);
      const actor = app.getActor(request);
      // Keys minting keys would let a leaked key silently extend its own life.
      if (actor.via === 'api_key') throw forbidden('API keys cannot create other API keys');

      const created = await createApiKey(org.orgId, actor.user.id, org.role, request.body);
      request.log.info(
        { orgId: org.orgId, apiKeyId: created.id, prefix: created.prefix },
        'api key created',
      );
      return reply.status(201).send(created);
    },
  );

  app.delete(
    '/orgs/:orgId/api-keys/:keyId',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        params: keyParams,
        response: { 200: apiKeySchema, 403: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => {
      const org = app.getOrg(request);
      const revoked = await revoke(org.orgId, request.params.keyId);
      request.log.info({ orgId: org.orgId, apiKeyId: revoked.id }, 'api key revoked');
      return revoked;
    },
  );
};
