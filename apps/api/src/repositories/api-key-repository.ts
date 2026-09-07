import { getDb, sql, type ApiKeyRow } from '@forge/db';
import type { OrgRole } from '@forge/shared';

export async function findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | undefined> {
  return getDb().selectFrom('api_keys').selectAll().where('prefix', '=', prefix).executeTakeFirst();
}

export async function listApiKeys(orgId: string): Promise<ApiKeyRow[]> {
  return getDb()
    .selectFrom('api_keys')
    .selectAll()
    .where('org_id', '=', orgId)
    .orderBy('created_at', 'desc')
    .execute();
}

export async function insertApiKey(input: {
  orgId: string;
  name: string;
  prefix: string;
  keyHash: string;
  role: OrgRole;
  scopes: string[];
  createdBy: string;
}): Promise<ApiKeyRow> {
  return getDb()
    .insertInto('api_keys')
    .values({
      org_id: input.orgId,
      name: input.name,
      prefix: input.prefix,
      key_hash: input.keyHash,
      role: input.role,
      scopes: input.scopes,
      created_by: input.createdBy,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Revocation is a tombstone, not a delete — the audit trail outlives the key. */
export async function revokeApiKey(orgId: string, keyId: string): Promise<ApiKeyRow | undefined> {
  return getDb()
    .updateTable('api_keys')
    .set({ revoked_at: sql<Date>`now()` })
    .where('id', '=', keyId)
    .where('org_id', '=', orgId)
    .where('revoked_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
}

/**
 * Fire-and-forget touch on the auth path; a failure here must never fail the
 * request the key was authenticating.
 */
export async function touchApiKeyLastUsed(keyId: string): Promise<void> {
  await getDb()
    .updateTable('api_keys')
    .set({ last_used_at: sql<Date>`now()` })
    .where('id', '=', keyId)
    .execute();
}
