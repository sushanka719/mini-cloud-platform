import fp from 'fastify-plugin';
import { env } from '@forge/config';
import {
  API_KEY_PREFIX,
  ORG_ROLE_RANK,
  forbidden,
  notFound,
  unauthorized,
  type OrgRole,
} from '@forge/shared';
import type { User } from '@forge/db';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { authenticateApiKey, touchApiKey } from '../services/api-key-service.js';
import { readSession, touchSession } from '../services/session-service.js';
import { findUserById } from '../repositories/user-repository.js';
import { findMembership, findOrgById, findOrgBySlug } from '../repositories/org-repository.js';

/**
 * Authentication + RBAC.
 *
 * Two credential kinds resolve to the same shape so every downstream check is
 * one comparison:
 *   - session cookie / `Authorization: Bearer <session token>` → a human user
 *   - `Authorization: Bearer fc_live_…`                        → an API key,
 *     which carries its own org and role
 *
 * Authoritative state is Redis (sessions) and Postgres (users, memberships) —
 * nothing is cached in process memory, so any replica can serve any request.
 */

export type Actor =
  | { via: 'session'; user: User; token: string }
  | { via: 'api_key'; user: User; apiKeyId: string; orgId: string; role: OrgRole };

/** The org the current route is scoped to, plus the caller's role in it. */
export type OrgContext = { orgId: string; slug: string; role: OrgRole };

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth preHandler; undefined on public routes. */
    actor?: Actor;
    /** Set by `orgScope`; only present on `/orgs/:orgId/*` routes. */
    orgContext?: OrgContext;
  }
  interface FastifyInstance {
    /** Rejects unauthenticated requests. */
    requireAuth: preHandlerAsyncHookHandler;
    /** Resolves `:orgId` (uuid or slug) + membership; rejects non-members. */
    requireOrg: preHandlerAsyncHookHandler;
    /** Requires at least `role` in the scoped org. Implies `requireOrg`. */
    requireRole: (role: OrgRole) => preHandlerAsyncHookHandler;
    /** Convenience accessors that throw rather than returning undefined. */
    getActor: (request: FastifyRequest) => Actor;
    getOrg: (request: FastifyRequest) => OrgContext;
  }
}

function readBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  const value = rest.join(' ').trim();
  return value.length > 0 ? value : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function authPlugin(app: FastifyInstance): Promise<void> {
  /**
   * Runs on every request. Populates `request.actor` when a valid credential is
   * present but never rejects — public routes stay public, and `requireAuth`
   * owns the 401 so the reason is in one place.
   */
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const bearer = readBearer(request);
    const cookieToken = request.cookies[env.SESSION_COOKIE_NAME];

    if (bearer?.startsWith(API_KEY_PREFIX)) {
      const key = await authenticateApiKey(bearer);
      if (!key) return;
      const user = await findUserById(key.created_by);
      if (!user) return; // creator deleted — the key is orphaned, treat as invalid
      touchApiKey(key.id, (err) => request.log.warn({ err }, 'failed to touch api key last_used_at'));
      request.actor = {
        via: 'api_key',
        user,
        apiKeyId: key.id,
        orgId: key.org_id,
        role: key.role,
      };
      return;
    }

    const token = bearer ?? cookieToken;
    if (!token) return;

    const record = await readSession(token);
    if (!record) return;

    const user = await findUserById(record.userId);
    if (!user) {
      // Session outlived its user. Nothing to authenticate as.
      return;
    }

    await touchSession(token, record);
    request.actor = { via: 'session', user, token };
  });

  app.decorate('getActor', (request: FastifyRequest): Actor => {
    if (!request.actor) throw unauthorized();
    return request.actor;
  });

  app.decorate('getOrg', (request: FastifyRequest): OrgContext => {
    if (!request.orgContext) {
      // A programming error, not a client error: the route forgot requireOrg.
      throw new Error('orgContext is not set — add requireOrg/requireRole to this route');
    }
    return request.orgContext;
  });

  const requireAuth: preHandlerAsyncHookHandler = async (request: FastifyRequest) => {
    if (!request.actor) throw unauthorized();
  };
  app.decorate('requireAuth', requireAuth);

  /**
   * Resolves the `:orgId` param — accepting either a uuid or a slug so URLs
   * can be readable — and attaches the caller's role.
   *
   * A non-member gets 404, not 403: telling a stranger "this org exists but you
   * can't see it" leaks the org's existence.
   */
  const requireOrg: preHandlerAsyncHookHandler = async (request: FastifyRequest) => {
    if (!request.actor) throw unauthorized();

    const params = request.params as { orgId?: string };
    const identifier = params.orgId;
    if (!identifier) {
      throw new Error('requireOrg used on a route without an :orgId param');
    }

    const org = UUID_RE.test(identifier)
      ? await findOrgById(identifier)
      : await findOrgBySlug(identifier);
    if (!org) throw notFound('ORG_NOT_FOUND', 'Organization not found');

    const actor = request.actor;

    if (actor.via === 'api_key') {
      // A key is bound to exactly one org; it cannot reach across tenants.
      if (actor.orgId !== org.id) throw notFound('ORG_NOT_FOUND', 'Organization not found');
      request.orgContext = { orgId: org.id, slug: org.slug, role: actor.role };
      return;
    }

    const membership = await findMembership(org.id, actor.user.id);
    if (!membership) throw notFound('ORG_NOT_FOUND', 'Organization not found');

    request.orgContext = { orgId: org.id, slug: org.slug, role: membership.role };
  };
  app.decorate('requireOrg', requireOrg);

  app.decorate('requireRole', (required: OrgRole): preHandlerAsyncHookHandler => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      await requireOrg.call(app, request, reply);
      const context = request.orgContext;
      if (!context) throw unauthorized();
      if (ORG_ROLE_RANK[context.role] < ORG_ROLE_RANK[required]) {
        throw forbidden(
          `This action requires the "${required}" role; you are a "${context.role}"`,
        );
      }
    };
  });
}

export default fp(authPlugin, { name: 'auth', dependencies: [] });
