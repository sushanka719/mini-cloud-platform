import { notFound, type EnvVar, type UpsertEnvVarInput } from '@forge/shared';
import { decryptSecret, encryptSecret, envVarRepo, type ProjectEnvVarRow } from '@forge/db';

/**
 * Env vars are always encrypted at rest. `is_secret` controls *disclosure*, not
 * storage: a non-secret value can be read back through the API, a secret one
 * never can — the only consumer of a secret's plaintext is the build/run
 * pipeline (CLAUDE.md §8).
 */

function toEnvVar(row: ProjectEnvVarRow): EnvVar {
  const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.key,
    isSecret: row.is_secret,
    value: row.is_secret ? null : decryptSecret(row.value_enc),
    valueLength: row.value_length,
    createdAt: iso(row.created_at as unknown as Date),
    updatedAt: iso(row.updated_at as unknown as Date),
  };
}

export async function getEnvVars(projectId: string): Promise<EnvVar[]> {
  return (await envVarRepo.listEnvVars(projectId)).map(toEnvVar);
}

export async function setEnvVar(
  projectId: string,
  input: UpsertEnvVarInput,
): Promise<EnvVar> {
  const row = await envVarRepo.upsertEnvVar({
    projectId,
    key: input.key,
    valueEnc: encryptSecret(input.value),
    valueLength: input.value.length,
    isSecret: input.isSecret,
  });
  return toEnvVar(row);
}

export async function setEnvVars(
  projectId: string,
  inputs: UpsertEnvVarInput[],
): Promise<EnvVar[]> {
  const rows = await envVarRepo.upsertEnvVars(
    inputs.map((input) => ({
      projectId,
      key: input.key,
      valueEnc: encryptSecret(input.value),
      valueLength: input.value.length,
      isSecret: input.isSecret,
    })),
  );
  return rows.map(toEnvVar);
}

export async function removeEnvVar(projectId: string, key: string): Promise<void> {
  const deleted = await envVarRepo.deleteEnvVar(projectId, key);
  if (deleted === 0) throw notFound('ENV_VAR_NOT_FOUND', `No env var named "${key}"`);
}

/**
 * Decrypted key/value pairs for the deployment pipeline. Deliberately not
 * reachable from any HTTP route — the worker will call this directly in
 * Phase 6, and it is the only function that returns secret plaintext.
 */
export async function resolveEnvForBuild(projectId: string): Promise<Record<string, string>> {
  const rows = await envVarRepo.listEnvVars(projectId);
  const resolved: Record<string, string> = {};
  for (const row of rows) resolved[row.key] = decryptSecret(row.value_enc);
  return resolved;
}

/** Reads a single var's plaintext. Same rule as above: not exposed over HTTP. */
export async function revealEnvVar(projectId: string, key: string): Promise<string> {
  const row = await envVarRepo.findEnvVar(projectId, key);
  if (!row) throw notFound('ENV_VAR_NOT_FOUND', `No env var named "${key}"`);
  return decryptSecret(row.value_enc);
}
