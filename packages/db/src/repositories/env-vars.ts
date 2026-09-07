import { getDb } from '../client.js';
import type { ProjectEnvVarRow } from '../types.js';
import { decryptSecret } from '../secret-box.js';

/**
 * Project env vars. Values are always AES-GCM encrypted at rest; `is_secret`
 * controls *disclosure*, not storage (DATA_MODEL §5).
 *
 * Shared rather than API-local because both apps read this table: the API to
 * manage the values, and the worker to inject them into a build.
 */

export async function listEnvVars(projectId: string): Promise<ProjectEnvVarRow[]> {
  return getDb()
    .selectFrom('project_env_vars')
    .selectAll()
    .where('project_id', '=', projectId)
    .orderBy('key', 'asc')
    .execute();
}

export async function findEnvVar(
  projectId: string,
  key: string,
): Promise<ProjectEnvVarRow | undefined> {
  return getDb()
    .selectFrom('project_env_vars')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('key', '=', key)
    .executeTakeFirst();
}

export type UpsertEnvVarRow = {
  projectId: string;
  key: string;
  valueEnc: Buffer;
  valueLength: number;
  isSecret: boolean;
};

/** Upsert on (project_id, key) — setting the same key twice updates in place. */
export async function upsertEnvVar(input: UpsertEnvVarRow): Promise<ProjectEnvVarRow> {
  return getDb()
    .insertInto('project_env_vars')
    .values({
      project_id: input.projectId,
      key: input.key,
      value_enc: input.valueEnc,
      value_length: input.valueLength,
      is_secret: input.isSecret,
    })
    .onConflict((oc) =>
      oc.columns(['project_id', 'key']).doUpdateSet({
        value_enc: input.valueEnc,
        value_length: input.valueLength,
        is_secret: input.isSecret,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** One transaction for a bulk `.env` paste, so a partial apply can't happen. */
export async function upsertEnvVars(rows: UpsertEnvVarRow[]): Promise<ProjectEnvVarRow[]> {
  if (rows.length === 0) return [];
  return getDb()
    .transaction()
    .execute(async (trx) => {
      const saved: ProjectEnvVarRow[] = [];
      for (const row of rows) {
        saved.push(
          await trx
            .insertInto('project_env_vars')
            .values({
              project_id: row.projectId,
              key: row.key,
              value_enc: row.valueEnc,
              value_length: row.valueLength,
              is_secret: row.isSecret,
            })
            .onConflict((oc) =>
              oc.columns(['project_id', 'key']).doUpdateSet({
                value_enc: row.valueEnc,
                value_length: row.valueLength,
                is_secret: row.isSecret,
              }),
            )
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
      }
      return saved;
    });
}

export async function deleteEnvVar(projectId: string, key: string): Promise<number> {
  const result = await getDb()
    .deleteFrom('project_env_vars')
    .where('project_id', '=', projectId)
    .where('key', '=', key)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/** One resolved env var, with the flag that decides whether it gets masked. */
export type ResolvedEnvVar = { key: string; value: string; isSecret: boolean };

/**
 * Decrypted key/value pairs for the deployment pipeline — the only function
 * here that returns secret plaintext, and deliberately not reachable from any
 * HTTP route. `isSecret` is carried through so the worker can build a redactor
 * for the build log (CLAUDE.md §8).
 */
export async function resolveEnvForBuild(projectId: string): Promise<ResolvedEnvVar[]> {
  const rows = await listEnvVars(projectId);
  return rows.map((row) => ({
    key: row.key,
    value: decryptSecret(row.value_enc),
    isSecret: row.is_secret,
  }));
}
