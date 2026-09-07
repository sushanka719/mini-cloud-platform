import {
  ORG_ROLE_RANK,
  conflict,
  forbidden,
  notFound,
  slugify,
  type OrgMembership,
  type OrgMemberView,
  type OrgRole,
  type PublicOrg,
} from '@forge/shared';
import {
  countOwners,
  deleteMember,
  findMembership,
  findOrgBySlug,
  insertOrgWithOwner,
  listMembers,
  listOrgsForUser,
  updateOrg,
  upsertMember,
} from '../repositories/org-repository.js';
import { findUserByEmail } from '../repositories/user-repository.js';
import { toMemberView, toOrgMembership, toPublicOrg } from './serializers.js';

async function uniqueOrgSlug(base: string, requested?: string): Promise<string> {
  if (requested) {
    if (await findOrgBySlug(requested)) {
      throw conflict('ORG_SLUG_TAKEN', `The slug "${requested}" is already in use`);
    }
    return requested;
  }
  const seed = slugify(base) || 'org';
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? seed : `${seed}-${attempt + 1}`;
    if (!(await findOrgBySlug(candidate))) return candidate;
  }
  throw conflict('ORG_SLUG_TAKEN', 'Could not derive a free organization slug; pass one directly');
}

export async function listUserOrgs(userId: string): Promise<OrgMembership[]> {
  return (await listOrgsForUser(userId)).map(toOrgMembership);
}

export async function createOrg(
  userId: string,
  input: { name: string; slug?: string },
): Promise<OrgMembership> {
  const slug = await uniqueOrgSlug(input.name, input.slug);
  const org = await insertOrgWithOwner({ name: input.name, slug, userId });
  // The creator is always the owner (enforced in the same transaction).
  return { ...toPublicOrg(org), role: 'owner' };
}

export async function renameOrg(
  orgId: string,
  patch: { name?: string; slug?: string },
): Promise<PublicOrg> {
  if (patch.slug) {
    const existing = await findOrgBySlug(patch.slug);
    if (existing && existing.id !== orgId) {
      throw conflict('ORG_SLUG_TAKEN', `The slug "${patch.slug}" is already in use`);
    }
  }
  const org = await updateOrg(orgId, patch);
  if (!org) throw notFound('ORG_NOT_FOUND', 'Organization not found');
  return toPublicOrg(org);
}

export async function getMembers(orgId: string): Promise<OrgMemberView[]> {
  return (await listMembers(orgId)).map(toMemberView);
}

/**
 * Adding a member requires the target user to already have an account — there
 * is no email delivery in this project, so "invite" is "add an existing user".
 */
export async function addMember(
  orgId: string,
  actorRole: OrgRole,
  input: { email: string; role: Exclude<OrgRole, 'owner'> },
): Promise<OrgMemberView> {
  assertCanGrant(actorRole, input.role);

  const user = await findUserByEmail(input.email);
  if (!user) {
    throw notFound('USER_NOT_FOUND', 'No account exists with that email address');
  }

  const existing = await findMembership(orgId, user.id);
  if (existing) {
    throw conflict('ALREADY_A_MEMBER', 'That user is already a member of this organization');
  }

  const member = await upsertMember(orgId, user.id, input.role);
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: member.role,
    joinedAt: new Date(member.created_at as unknown as Date).toISOString(),
  };
}

export async function changeMemberRole(
  orgId: string,
  actorUserId: string,
  actorRole: OrgRole,
  targetUserId: string,
  role: Exclude<OrgRole, 'owner'>,
): Promise<OrgMemberView> {
  assertCanGrant(actorRole, role);

  const target = await findMembership(orgId, targetUserId);
  if (!target) throw notFound('MEMBER_NOT_FOUND', 'That user is not a member of this organization');

  // An admin can't demote an owner, and the last owner can't demote themselves
  // — either would leave the org with nobody able to administer it.
  if (target.role === 'owner') {
    if (actorRole !== 'owner') {
      throw forbidden('Only an owner can change another owner’s role');
    }
    if ((await countOwners(orgId)) <= 1) {
      throw conflict('LAST_OWNER', 'An organization must keep at least one owner');
    }
  }
  if (targetUserId === actorUserId && actorRole === 'owner' && (await countOwners(orgId)) <= 1) {
    throw conflict('LAST_OWNER', 'An organization must keep at least one owner');
  }

  await upsertMember(orgId, targetUserId, role);
  const members = await getMembers(orgId);
  const updated = members.find((m) => m.userId === targetUserId);
  if (!updated) throw notFound('MEMBER_NOT_FOUND', 'Member disappeared during update');
  return updated;
}

export async function removeMember(
  orgId: string,
  actorRole: OrgRole,
  targetUserId: string,
): Promise<void> {
  const target = await findMembership(orgId, targetUserId);
  if (!target) throw notFound('MEMBER_NOT_FOUND', 'That user is not a member of this organization');

  if (target.role === 'owner') {
    if (actorRole !== 'owner') throw forbidden('Only an owner can remove another owner');
    if ((await countOwners(orgId)) <= 1) {
      throw conflict('LAST_OWNER', 'An organization must keep at least one owner');
    }
  }

  const deleted = await deleteMember(orgId, targetUserId);
  if (deleted === 0) throw notFound('MEMBER_NOT_FOUND', 'That user is not a member');
}

/** Nobody may grant a role above their own — that's privilege escalation. */
function assertCanGrant(actorRole: OrgRole, targetRole: OrgRole): void {
  if (ORG_ROLE_RANK[targetRole] > ORG_ROLE_RANK[actorRole]) {
    throw forbidden(`You cannot grant the "${targetRole}" role`);
  }
}
