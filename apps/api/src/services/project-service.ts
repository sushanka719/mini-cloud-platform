import {
  conflict,
  notFound,
  slugify,
  type CreateProjectInput,
  type Project,
  type UpdateProjectInput,
} from '@forge/shared';
import { projectPrefix } from '@forge/storage';
import type { ProjectRow, ProjectUpdate } from '@forge/db';
import {
  deleteProject,
  findProjectById,
  findProjectBySlug,
  insertProject,
  listProjects,
  updateProject,
} from '../repositories/project-repository.js';
import { objectStore } from '../lib/object-store.js';
import { toProject } from './serializers.js';

/** Slugs are unique per org, so the search only has to avoid siblings. */
async function uniqueProjectSlug(
  orgId: string,
  base: string,
  requested?: string,
): Promise<string> {
  if (requested) {
    if (await findProjectBySlug(orgId, requested)) {
      throw conflict('PROJECT_SLUG_TAKEN', `A project with the slug "${requested}" already exists`);
    }
    return requested;
  }
  const seed = slugify(base) || 'project';
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? seed : `${seed}-${attempt + 1}`;
    if (!(await findProjectBySlug(orgId, candidate))) return candidate;
  }
  throw conflict('PROJECT_SLUG_TAKEN', 'Could not derive a free project slug; pass one directly');
}

export async function getProjects(orgId: string): Promise<Project[]> {
  return (await listProjects(orgId)).map(toProject);
}

/**
 * Every project lookup goes through here so the org filter can't be forgotten.
 * Returns the raw row for callers that need the id/slug for storage paths.
 */
export async function requireProject(orgId: string, projectId: string): Promise<ProjectRow> {
  const project = await findProjectById(orgId, projectId);
  if (!project) throw notFound('PROJECT_NOT_FOUND', 'Project not found');
  return project;
}

export async function getProject(orgId: string, projectId: string): Promise<Project> {
  return toProject(await requireProject(orgId, projectId));
}

export async function createProject(
  orgId: string,
  userId: string,
  input: CreateProjectInput,
): Promise<Project> {
  const row = await insertProject({
    orgId,
    name: input.name,
    slug: await uniqueProjectSlug(orgId, input.name, input.slug),
    sourceType: input.sourceType,
    repoUrl: input.repoUrl ?? null,
    rootDir: input.rootDir ?? '.',
    installCommand: input.installCommand,
    buildCommand: input.buildCommand,
    startCommand: input.startCommand,
    appPort: input.appPort,
    healthPath: input.healthPath,
    healthTimeoutMs: input.healthTimeoutMs,
    createdBy: userId,
  });
  return toProject(row);
}

export async function editProject(
  orgId: string,
  projectId: string,
  input: UpdateProjectInput,
): Promise<Project> {
  await requireProject(orgId, projectId);

  // Map camelCase input → snake_case columns explicitly, so an unexpected key
  // in the body can never reach the UPDATE statement.
  const patch: ProjectUpdate = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.repoUrl !== undefined) patch.repo_url = input.repoUrl ?? null;
  if (input.rootDir !== undefined) patch.root_dir = input.rootDir;
  if (input.installCommand !== undefined) patch.install_command = input.installCommand;
  if (input.buildCommand !== undefined) patch.build_command = input.buildCommand;
  if (input.startCommand !== undefined) patch.start_command = input.startCommand;
  if (input.appPort !== undefined) patch.app_port = input.appPort;
  if (input.healthPath !== undefined) patch.health_path = input.healthPath;
  if (input.healthTimeoutMs !== undefined) patch.health_timeout_ms = input.healthTimeoutMs;

  if (Object.keys(patch).length === 0) return getProject(orgId, projectId);

  const updated = await updateProject(orgId, projectId, patch);
  if (!updated) throw notFound('PROJECT_NOT_FOUND', 'Project not found');
  return toProject(updated);
}

/**
 * Removes the DB row (env vars and file rows cascade), then drops the project's
 * whole subtree from the object store. Order matters: the row goes first so a
 * failure here leaves unreachable bytes (reported as orphans by
 * `GET …/storage`) rather than a project pointing at files that are gone.
 */
export async function removeProject(orgId: string, projectId: string): Promise<void> {
  const deleted = await deleteProject(orgId, projectId);
  if (deleted === 0) throw notFound('PROJECT_NOT_FOUND', 'Project not found');
  await objectStore.deletePrefix(projectPrefix(orgId, projectId));
}
