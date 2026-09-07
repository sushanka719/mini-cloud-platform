import {
  API_KEY_LOOKUP_LENGTH,
  API_KEY_PREFIX,
  ORG_ROLE_RANK,
  forbidden,
  notFound,
  type ApiKeyView,
  type CreatedApiKey,
  type OrgRole,
} from '@forge/shared';
import type { ApiKeyRow } from '@forge/db';
import { generateApiKey, hashToken, safeEqual } from '../lib/crypto.js';
import {
  findApiKeyByPrefix,
  insertApiKey,
  listApiKeys,
  revokeApiKey,
  touchApiKeyLastUsed,
} from '../repositories/api-key-repository.js';
import { toApiKeyView } from './serializers.js';

export async function getApiKeys(orgId: string): Promise<ApiKeyView[]> {
  return (await listApiKeys(orgId)).map(toApiKeyView);
}

export async function createApiKey(
  orgId: string,
  actorUserId: string,
  actorRole: OrgRole,
  input: { name: string; role: Exclude<OrgRole, 'owner'>; scopes: string[] },
): Promise<CreatedApiKey> {
  // A key is a bearer credential; letting a member mint an admin key would be a
  // one-request privilege escalation.
  if (ORG_ROLE_RANK[input.role] > ORG_ROLE_RANK[actorRole]) {
    throw forbidden(`You cannot create a key with the "${input.role}" role`);
  }

  const generated = generateApiKey();
  const row = await insertApiKey({
    orgId,
    name: input.name,
    prefix: generated.prefix,
    keyHash: generated.keyHash,
    role: input.role,
    scopes: input.scopes,
    createdBy: actorUserId,
  });

  // The only moment the plaintext key exists outside the caller's request.
  return { ...toApiKeyView(row), key: generated.key };
}

export async function revoke(orgId: string, keyId: string): Promise<ApiKeyView> {
  const row = await revokeApiKey(orgId, keyId);
  if (!row) throw notFound('API_KEY_NOT_FOUND', 'API key not found or already revoked');
  return toApiKeyView(row);
}

/**
 * Auth path for `Authorization: Bearer fc_live_…`. Returns the row only for a
 * well-formed, unrevoked key whose hash matches.
 */
export async function authenticateApiKey(rawKey: string): Promise<ApiKeyRow | null> {
  if (!rawKey.startsWith(API_KEY_PREFIX) || rawKey.length <= API_KEY_LOOKUP_LENGTH) return null;

  const row = await findApiKeyByPrefix(rawKey.slice(0, API_KEY_LOOKUP_LENGTH));
  if (!row || row.revoked_at) return null;
  // Constant-time compare even though the prefix already narrowed to one row.
  if (!safeEqual(row.key_hash, hashToken(rawKey))) return null;

  return row;
}

/**
 * Records usage without blocking or failing the request the key authenticated
 * — a `last_used_at` write is bookkeeping, not part of the auth decision.
 */
export function touchApiKey(keyId: string, onError: (err: unknown) => void): void {
  void touchApiKeyLastUsed(keyId).catch(onError);
}
