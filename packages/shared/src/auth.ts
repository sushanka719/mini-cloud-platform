import { z } from 'zod';
import { orgRoleSchema } from './enums.js';

/**
 * Auth + org contracts. Producer (API routes) and consumer (dashboard) both
 * derive their types from here — see CONVENTIONS §4.
 */

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

/**
 * Deliberately permissive on composition and strict on length: length is the
 * property that actually resists guessing, and argon2 handles the rest.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password must be at most 200 characters');

export const nameSchema = z.string().trim().min(1).max(120);

/** Lowercase, url-safe, no leading/trailing/doubled dashes. */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single dashes');

/** Best-effort slug from a display name; the caller still validates the result. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

// --- Users -----------------------------------------------------------------

export const registerSchema = z.object({
  email: emailSchema,
  name: nameSchema,
  password: passwordSchema,
  /** Optional org created and owned by the new user; defaults to "<name>'s org". */
  orgName: nameSchema.optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** A user as returned by the API. Never carries `password_hash`. */
export const publicUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  createdAt: z.string(),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

// --- Organizations ---------------------------------------------------------

export const publicOrgSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
});
export type PublicOrg = z.infer<typeof publicOrgSchema>;

/** An org as seen by the current user — includes their role in it. */
export const orgMembershipSchema = publicOrgSchema.extend({
  role: orgRoleSchema,
});
export type OrgMembership = z.infer<typeof orgMembershipSchema>;

export const createOrgSchema = z.object({
  name: nameSchema,
  slug: slugSchema.optional(),
});
export type CreateOrgInput = z.infer<typeof createOrgSchema>;

export const updateOrgSchema = z
  .object({ name: nameSchema.optional(), slug: slugSchema.optional() })
  .refine((v) => v.name !== undefined || v.slug !== undefined, {
    message: 'Provide at least one field to update',
  });
export type UpdateOrgInput = z.infer<typeof updateOrgSchema>;

// --- Members ---------------------------------------------------------------

export const orgMemberSchema = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: orgRoleSchema,
  joinedAt: z.string(),
});
export type OrgMemberView = z.infer<typeof orgMemberSchema>;

/**
 * Adding a member by email. `owner` is excluded: ownership transfers are a
 * separate operation, not something an admin can grant sideways.
 */
export const addMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(['viewer', 'member', 'admin']),
});
export type AddMemberInput = z.infer<typeof addMemberSchema>;

export const updateMemberSchema = z.object({
  role: z.enum(['viewer', 'member', 'admin']),
});
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

// --- API keys --------------------------------------------------------------

export const apiKeySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** Non-secret display prefix, e.g. `fc_live_ab12cd34`. */
  prefix: z.string(),
  role: orgRoleSchema,
  scopes: z.array(z.string()),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ApiKeyView = z.infer<typeof apiKeySchema>;

/** Returned exactly once, at creation. The plaintext key is never stored. */
export const createdApiKeySchema = apiKeySchema.extend({
  key: z.string(),
});
export type CreatedApiKey = z.infer<typeof createdApiKeySchema>;

export const createApiKeySchema = z.object({
  name: nameSchema,
  /** The key acts with this role inside its org; capped by the creator's role. */
  role: z.enum(['viewer', 'member', 'admin']).default('member'),
  scopes: z.array(z.string().min(1).max(64)).max(32).default([]),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

// --- Session ---------------------------------------------------------------

/** `GET /auth/me` — who am I, and which orgs can I see. */
export const sessionResponseSchema = z.object({
  user: publicUserSchema,
  orgs: z.array(orgMembershipSchema),
  /** 'session' for a browser cookie/bearer token, 'api_key' for programmatic calls. */
  via: z.enum(['session', 'api_key']),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const authResponseSchema = z.object({
  user: publicUserSchema,
  orgs: z.array(orgMembershipSchema),
  /** Also returned in the body so non-browser clients can use a bearer token. */
  token: z.string(),
  expiresAt: z.string(),
});
export type AuthResponse = z.infer<typeof authResponseSchema>;
