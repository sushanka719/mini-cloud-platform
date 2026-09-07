import { z } from 'zod';
import {
  addMemberSchema,
  createOrgSchema,
  errorResponseSchema,
  forbidden,
  orgMemberSchema,
  notFound,
  orgMembershipSchema,
  publicOrgSchema,
  updateMemberSchema,
  updateOrgSchema,
} from '@forge/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  addMember,
  changeMemberRole,
  createOrg,
  getMembers,
  listUserOrgs,
  removeMember,
  renameOrg,
} from '../services/org-service.js';
import { findOrgById } from '../repositories/org-repository.js';
import { toPublicOrg } from '../services/serializers.js';

const orgParams = z.object({ orgId: z.string().min(1) });
const memberParams = orgParams.extend({ userId: z.string().uuid() });

/**
 * Read routes need membership (`requireOrg`); mutations need at least `admin`.
 * `viewer` and `member` can therefore see an org but not change it — that's the
 * forbidden-action demo in the Phase 1 checkpoint.
 */
export const orgRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/orgs',
    {
      preHandler: app.requireAuth,
      schema: { response: { 200: z.array(orgMembershipSchema), 401: errorResponseSchema } },
    },
    async (request) => {
      const actor = app.getActor(request);
      const orgs = await listUserOrgs(actor.user.id);
      return actor.via === 'api_key' ? orgs.filter((o) => o.id === actor.orgId) : orgs;
    },
  );

  app.post(
    '/orgs',
    {
      preHandler: app.requireAuth,
      schema: {
        body: createOrgSchema,
        response: {
          201: orgMembershipSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const actor = app.getActor(request);
      // A key is scoped to one org and must not be able to spawn new tenants.
      if (actor.via === 'api_key') throw forbidden('API keys cannot create organizations');
      return reply.status(201).send(await createOrg(actor.user.id, request.body));
    },
  );

  app.get(
    '/orgs/:orgId',
    {
      preHandler: app.requireOrg,
      schema: {
        params: orgParams,
        response: { 200: orgMembershipSchema, 404: errorResponseSchema },
      },
    },
    async (request) => {
      const org = app.getOrg(request);
      const actor = app.getActor(request);
      const orgs = await listUserOrgs(actor.user.id);
      const found = orgs.find((o) => o.id === org.orgId);
      if (found) return found;
      // An API key's creator may not be a member; fall back to the key's role.
      const row = await findOrgById(org.orgId);
      if (!row) throw notFound('ORG_NOT_FOUND', 'Organization not found');
      return { ...toPublicOrg(row), role: org.role };
    },
  );

  app.patch(
    '/orgs/:orgId',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        params: orgParams,
        body: updateOrgSchema,
        response: {
          200: publicOrgSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const org = app.getOrg(request);
      return renameOrg(org.orgId, request.body);
    },
  );

  // --- members --------------------------------------------------------------

  app.get(
    '/orgs/:orgId/members',
    {
      preHandler: app.requireOrg,
      schema: {
        params: orgParams,
        response: { 200: z.array(orgMemberSchema), 404: errorResponseSchema },
      },
    },
    async (request) => getMembers(app.getOrg(request).orgId),
  );

  app.post(
    '/orgs/:orgId/members',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        params: orgParams,
        body: addMemberSchema,
        response: {
          201: orgMemberSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const org = app.getOrg(request);
      const member = await addMember(org.orgId, org.role, request.body);
      return reply.status(201).send(member);
    },
  );

  app.patch(
    '/orgs/:orgId/members/:userId',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        params: memberParams,
        body: updateMemberSchema,
        response: {
          200: orgMemberSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const org = app.getOrg(request);
      const actor = app.getActor(request);
      return changeMemberRole(
        org.orgId,
        actor.user.id,
        org.role,
        request.params.userId,
        request.body.role,
      );
    },
  );

  app.delete(
    '/orgs/:orgId/members/:userId',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        params: memberParams,
        response: {
          204: z.null(),
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const org = app.getOrg(request);
      await removeMember(org.orgId, org.role, request.params.userId);
      return reply.status(204).send(null);
    },
  );
};
