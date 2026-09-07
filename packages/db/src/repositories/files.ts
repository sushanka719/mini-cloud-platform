import { getDb } from '../client.js';
import type { FileRow } from '../types.js';
import type { FileCompression, FileKind } from '@forge/shared';

/**
 * The `files` table is the index of the local object store: one row per stored
 * object, with the key, its size and its sha256. Reads are always scoped to a
 * project so a file id from another org resolves to "not found".
 *
 * Shared rather than API-local because the worker writes here too: a build
 * produces a log object (and, from Phase 7, an artifact) that needs indexing.
 */

export type InsertFileInput = {
  projectId: string | null;
  deploymentId: string | null;
  kind: FileKind;
  storagePath: string;
  sizeBytes: number;
  checksum: string | null;
  contentType: string | null;
  originalName: string | null;
  parentFileId?: string | null;
  compression?: FileCompression | null;
  uncompressedBytes?: number | null;
  uncompressedChecksum?: string | null;
};

export async function insertFile(input: InsertFileInput): Promise<FileRow> {
  return getDb()
    .insertInto('files')
    .values({
      project_id: input.projectId,
      deployment_id: input.deploymentId,
      kind: input.kind,
      storage_path: input.storagePath,
      size_bytes: input.sizeBytes,
      checksum: input.checksum,
      content_type: input.contentType,
      original_name: input.originalName,
      parent_file_id: input.parentFileId ?? null,
      compression: input.compression ?? null,
      uncompressed_bytes: input.uncompressedBytes ?? null,
      uncompressed_checksum: input.uncompressedChecksum ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function listProjectFiles(
  projectId: string,
  kind?: FileKind,
  limit = 50,
): Promise<FileRow[]> {
  let query = getDb().selectFrom('files').selectAll().where('project_id', '=', projectId);
  if (kind) query = query.where('kind', '=', kind);
  return query.orderBy('created_at', 'desc').limit(limit).execute();
}

export async function findProjectFile(
  projectId: string,
  fileId: string,
): Promise<FileRow | undefined> {
  return getDb()
    .selectFrom('files')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('id', '=', fileId)
    .executeTakeFirst();
}

/** Any file id, unscoped — the worker already holds the deployment's row. */
export async function findFileById(fileId: string): Promise<FileRow | undefined> {
  return getDb().selectFrom('files').selectAll().where('id', '=', fileId).executeTakeFirst();
}

/**
 * Files produced by one deployment — its build log today, its artifact from
 * Phase 7. Newest first, so "the log" is the first row.
 */
export async function listDeploymentFiles(
  deploymentId: string,
  kind?: FileKind,
): Promise<FileRow[]> {
  let query = getDb().selectFrom('files').selectAll().where('deployment_id', '=', deploymentId);
  if (kind) query = query.where('kind', '=', kind);
  return query.orderBy('created_at', 'desc').execute();
}

/** Just the keys — used to reconcile the DB index against what's on disk. */
export async function listProjectFileIndex(
  projectId: string,
): Promise<{ storage_path: string; kind: FileKind; size_bytes: number }[]> {
  return getDb()
    .selectFrom('files')
    .select(['storage_path', 'kind', 'size_bytes'])
    .where('project_id', '=', projectId)
    .execute();
}

export async function deleteFileRow(projectId: string, fileId: string): Promise<number> {
  const result = await getDb()
    .deleteFrom('files')
    .where('project_id', '=', projectId)
    .where('id', '=', fileId)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
