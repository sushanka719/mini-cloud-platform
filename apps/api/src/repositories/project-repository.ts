import { getDb, type ProjectRow, type ProjectUpdate } from '@forge/db';
import type { SourceType } from '@forge/shared';

/**
 * Every read here filters by `org_id` as well as the project id. A caller who
 * guesses a uuid from another org gets "not found", not someone else's project
 * (DATA_MODEL §5, multi-tenancy).
 */

export async function listProjects(orgId: string): Promise<ProjectRow[]> {
  return getDb()
    .selectFrom('projects')
    .selectAll()
    .where('org_id', '=', orgId)
    .orderBy('created_at', 'desc')
    .execute();
}

export async function findProjectById(
  orgId: string,
  projectId: string,
): Promise<ProjectRow | undefined> {
  return getDb()
    .selectFrom('projects')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('id', '=', projectId)
    .executeTakeFirst();
}

export async function findProjectBySlug(
  orgId: string,
  slug: string,
): Promise<ProjectRow | undefined> {
  return getDb()
    .selectFrom('projects')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('slug', '=', slug)
    .executeTakeFirst();
}

export type InsertProjectInput = {
  orgId: string;
  name: string;
  slug: string;
  sourceType: SourceType;
  repoUrl: string | null;
  rootDir: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  appPort: number;
  healthPath: string;
  healthTimeoutMs: number;
  createdBy: string;
};

export async function insertProject(input: InsertProjectInput): Promise<ProjectRow> {
  return getDb()
    .insertInto('projects')
    .values({
      org_id: input.orgId,
      name: input.name,
      slug: input.slug,
      source_type: input.sourceType,
      repo_url: input.repoUrl,
      root_dir: input.rootDir,
      install_command: input.installCommand,
      build_command: input.buildCommand,
      start_command: input.startCommand,
      app_port: input.appPort,
      health_path: input.healthPath,
      health_timeout_ms: input.healthTimeoutMs,
      created_by: input.createdBy,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateProject(
  orgId: string,
  projectId: string,
  patch: ProjectUpdate,
): Promise<ProjectRow | undefined> {
  return getDb()
    .updateTable('projects')
    .set(patch)
    .where('org_id', '=', orgId)
    .where('id', '=', projectId)
    .returningAll()
    .executeTakeFirst();
}

export async function deleteProject(orgId: string, projectId: string): Promise<number> {
  const result = await getDb()
    .deleteFrom('projects')
    .where('org_id', '=', orgId)
    .where('id', '=', projectId)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/**
 * The owning org of a project, without knowing the org up front.
 *
 * Every *data* read stays org-scoped (`findProjectById`); this exists only so
 * the WebSocket gateway can derive which org a `project:<id>` topic belongs to
 * and then verify membership in it. Resolving the org is not authorization —
 * the membership check that follows is.
 */
export async function findProjectOrg(
  projectId: string,
): Promise<{ id: string; org_id: string } | undefined> {
  return getDb()
    .selectFrom('projects')
    .select(['id', 'org_id'])
    .where('id', '=', projectId)
    .executeTakeFirst();
}
