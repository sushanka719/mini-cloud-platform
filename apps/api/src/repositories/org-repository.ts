import { getDb, type Organization, type OrgMember, type Timestamp } from '@forge/db';
import type { OrgRole } from '@forge/shared';

export type OrgWithRole = Organization & { role: OrgRole };

export type MemberWithUser = {
  user_id: string;
  email: string;
  name: string;
  role: OrgRole;
  created_at: Timestamp;
};

export async function findOrgById(id: string): Promise<Organization | undefined> {
  return getDb().selectFrom('organizations').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function findOrgBySlug(slug: string): Promise<Organization | undefined> {
  return getDb()
    .selectFrom('organizations')
    .selectAll()
    .where('slug', '=', slug)
    .executeTakeFirst();
}

/** Every org the user belongs to, with their role. Drives the org switcher. */
export async function listOrgsForUser(userId: string): Promise<OrgWithRole[]> {
  return getDb()
    .selectFrom('organizations as o')
    .innerJoin('org_members as m', 'm.org_id', 'o.id')
    .where('m.user_id', '=', userId)
    .select([
      'o.id',
      'o.name',
      'o.slug',
      'o.created_by',
      'o.created_at',
      'o.updated_at',
      'm.role',
    ])
    .orderBy('o.created_at', 'asc')
    .execute();
}

/** The single query behind every RBAC decision. */
export async function findMembership(
  orgId: string,
  userId: string,
): Promise<OrgMember | undefined> {
  return getDb()
    .selectFrom('org_members')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
}

export async function listMembers(orgId: string): Promise<MemberWithUser[]> {
  return getDb()
    .selectFrom('org_members as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .where('m.org_id', '=', orgId)
    .select(['m.user_id', 'u.email', 'u.name', 'm.role', 'm.created_at'])
    .orderBy('m.created_at', 'asc')
    .execute();
}

export async function countOwners(orgId: string): Promise<number> {
  const row = await getDb()
    .selectFrom('org_members')
    .where('org_id', '=', orgId)
    .where('role', '=', 'owner')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/**
 * Creates the org and its first membership in one transaction — an org with no
 * owner would be unreachable by anyone.
 */
export async function insertOrgWithOwner(input: {
  name: string;
  slug: string;
  userId: string;
}): Promise<Organization> {
  return getDb()
    .transaction()
    .execute(async (trx) => {
      const org = await trx
        .insertInto('organizations')
        .values({ name: input.name, slug: input.slug, created_by: input.userId })
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('org_members')
        .values({ org_id: org.id, user_id: input.userId, role: 'owner' })
        .execute();

      return org;
    });
}

export async function updateOrg(
  orgId: string,
  patch: { name?: string; slug?: string },
): Promise<Organization | undefined> {
  return getDb()
    .updateTable('organizations')
    .set(patch)
    .where('id', '=', orgId)
    .returningAll()
    .executeTakeFirst();
}

export async function upsertMember(
  orgId: string,
  userId: string,
  role: OrgRole,
): Promise<OrgMember> {
  return getDb()
    .insertInto('org_members')
    .values({ org_id: orgId, user_id: userId, role })
    .onConflict((oc) => oc.columns(['org_id', 'user_id']).doUpdateSet({ role }))
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function deleteMember(orgId: string, userId: string): Promise<number> {
  const result = await getDb()
    .deleteFrom('org_members')
    .where('org_id', '=', orgId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
