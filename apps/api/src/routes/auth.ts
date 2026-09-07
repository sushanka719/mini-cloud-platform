import { z } from 'zod';
import {
  authResponseSchema,
  errorResponseSchema,
  loginSchema,
  passwordSchema,
  registerSchema,
  sessionResponseSchema,
} from '@forge/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { changePassword, login, register } from '../services/auth-service.js';
import { destroySession } from '../services/session-service.js';
import { listUserOrgs } from '../services/org-service.js';
import { toPublicUser } from '../services/serializers.js';
import { clearSessionCookie, setSessionCookie } from '../lib/session-cookie.js';

/**
 * Credential endpoints get a far tighter bucket than the global 300/min: these
 * are the routes worth brute-forcing.
 */
const AUTH_RATE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/auth/register',
    {
      ...AUTH_RATE_LIMIT,
      schema: {
        body: registerSchema,
        response: {
          201: authResponseSchema,
          409: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await register(request.body, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      });
      setSessionCookie(reply, result.token, new Date(result.expiresAt));
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/auth/login',
    {
      ...AUTH_RATE_LIMIT,
      schema: {
        body: loginSchema,
        response: {
          200: authResponseSchema,
          401: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await login(request.body, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      });
      setSessionCookie(reply, result.token, new Date(result.expiresAt));
      return reply.status(200).send(result);
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: { response: { 204: z.null() } },
    },
    async (request, reply) => {
      // Idempotent: logging out without a session is a no-op, not a 401.
      const actor = request.actor;
      if (actor?.via === 'session') await destroySession(actor.token);
      clearSessionCookie(reply);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/auth/me',
    {
      preHandler: app.requireAuth,
      schema: {
        response: { 200: sessionResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) => {
      const actor = app.getActor(request);
      return {
        user: toPublicUser(actor.user),
        // An API key sees only its own org; a session sees every org the user
        // is a member of.
        orgs:
          actor.via === 'api_key'
            ? (await listUserOrgs(actor.user.id)).filter((o) => o.id === actor.orgId)
            : await listUserOrgs(actor.user.id),
        via: actor.via,
      };
    },
  );

  app.post(
    '/auth/change-password',
    {
      ...AUTH_RATE_LIMIT,
      preHandler: app.requireAuth,
      schema: {
        body: z.object({
          currentPassword: z.string().min(1).max(200),
          newPassword: passwordSchema,
        }),
        response: { 204: z.null(), 400: errorResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const actor = app.getActor(request);
      await changePassword(actor.user.id, request.body.currentPassword, request.body.newPassword);
      // Every session died, including this one — drop the cookie too.
      clearSessionCookie(reply);
      return reply.status(204).send(null);
    },
  );
};
