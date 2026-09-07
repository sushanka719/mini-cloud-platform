import { badRequest, conflict, slugify, unauthorized, type AuthResponse } from '@forge/shared';
import { fakeVerifyPassword, hashPassword, verifyPassword } from '../lib/crypto.js';
import {
  findUserByEmail,
  findUserById,
  insertUser,
  updateUserPassword,
} from '../repositories/user-repository.js';
import {
  findOrgBySlug,
  insertOrgWithOwner,
  listOrgsForUser,
} from '../repositories/org-repository.js';
import { createSession, destroyAllSessions } from './session-service.js';
import { toOrgMembership, toPublicUser } from './serializers.js';

export type RequestContext = { userAgent?: string; ip?: string };

/**
 * Postgres unique-violation. Two concurrent registrations for the same email
 * both pass the pre-check and one loses the insert — turn that into a clean 409
 * instead of a 500.
 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/** Appends -2, -3 … until the slug is free. Bounded so it can't spin. */
async function uniqueOrgSlug(base: string): Promise<string> {
  const seed = slugify(base) || 'org';
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? seed : `${seed}-${attempt + 1}`;
    if (!(await findOrgBySlug(candidate))) return candidate;
  }
  throw conflict('ORG_SLUG_TAKEN', 'Could not derive a free organization slug; pass one directly');
}

export async function register(
  input: { email: string; name: string; password: string; orgName?: string },
  context: RequestContext,
): Promise<AuthResponse> {
  if (await findUserByEmail(input.email)) {
    throw conflict('EMAIL_TAKEN', 'An account with that email already exists');
  }

  const passwordHash = await hashPassword(input.password);

  let user;
  try {
    user = await insertUser({ email: input.email, name: input.name, passwordHash });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict('EMAIL_TAKEN', 'An account with that email already exists', err);
    }
    throw err;
  }

  // Every user gets an org they own, so the dashboard is never empty and there
  // is always an RBAC scope to hang projects off.
  const orgName = input.orgName ?? `${input.name}'s org`;
  await insertOrgWithOwner({
    name: orgName,
    slug: await uniqueOrgSlug(orgName),
    userId: user.id,
  });

  const orgs = await listOrgsForUser(user.id);
  const session = await createSession(user.id, context);

  return {
    user: toPublicUser(user),
    orgs: orgs.map(toOrgMembership),
    token: session.token,
    expiresAt: session.expiresAt.toISOString(),
  };
}

export async function login(
  input: { email: string; password: string },
  context: RequestContext,
): Promise<AuthResponse> {
  const user = await findUserByEmail(input.email);

  if (!user) {
    // Spend comparable time so response latency doesn't reveal whether the
    // email exists, then fail with the same generic message as a bad password.
    await fakeVerifyPassword();
    throw unauthorized('Invalid email or password');
  }

  if (!(await verifyPassword(user.password_hash, input.password))) {
    throw unauthorized('Invalid email or password');
  }

  const orgs = await listOrgsForUser(user.id);
  const session = await createSession(user.id, context);

  return {
    user: toPublicUser(user),
    orgs: orgs.map(toOrgMembership),
    token: session.token,
    expiresAt: session.expiresAt.toISOString(),
  };
}

/**
 * Changing a password invalidates every existing session for that user — a
 * password change that leaves a stolen cookie working isn't a password change.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await findUserById(userId);
  if (!user) throw unauthorized();
  if (!(await verifyPassword(user.password_hash, currentPassword))) {
    throw badRequest('INVALID_PASSWORD', 'Current password is incorrect');
  }
  await updateUserPassword(userId, await hashPassword(newPassword));
  await destroyAllSessions(userId);
}
