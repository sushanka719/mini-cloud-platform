import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { env } from '@forge/config';
import { AppError, badRequest, conflict, type ArtifactResult } from '@forge/shared';
import { artifactKey, gzipObject } from '@forge/storage';
import { fileRepo, type ProjectRow } from '@forge/db';
import { requireProjectFile } from './file-service.js';
import { objectStore } from '../lib/object-store.js';
import { toStoredFile } from './serializers.js';

/**
 * Artifact production: gzip a stored object into a new `kind='artifact'` object.
 *
 * The compression itself happens on a `worker_threads` thread (see
 * `@forge/storage`'s compress pool). gzip is CPU-bound and the sha256 passes
 * around it are synchronous, so doing this inline would stall every other
 * request for the duration of a multi-megabyte archive (CLAUDE.md §4).
 *
 * Phase 6/7 reuse exactly this call to package a real build output; today it
 * runs against an uploaded source so the pipeline is exercised end to end.
 */

export async function compressProjectFile(
  project: ProjectRow,
  fileId: string,
): Promise<ArtifactResult> {
  const source = await requireProjectFile(project.id, fileId);

  if (source.compression !== null) {
    throw conflict('ALREADY_COMPRESSED', 'That object is already compressed');
  }
  if (source.kind === 'artifact') {
    throw badRequest('NOT_COMPRESSIBLE', 'Artifacts are produced from sources and logs');
  }
  if (!(await objectStore.head(source.storage_path))) {
    throw badRequest('OBJECT_MISSING', 'The object is indexed but missing from the object store');
  }

  const objectName = `${randomUUID()}.gz`;
  const targetKey = artifactKey(project.org_id, project.id, objectName);

  const result = await gzipObject(objectStore, source.storage_path, targetKey, {
    level: env.GZIP_LEVEL,
  });

  // The worker re-hashes the source as it reads it, so this is a free integrity
  // check against what was recorded at upload time. A mismatch means the bytes
  // on disk changed underneath us — refuse to index an artifact built from them.
  if (source.checksum && result.inputChecksum !== source.checksum) {
    await objectStore.delete(result.key);
    throw new AppError(
      'CHECKSUM_MISMATCH',
      500,
      'The stored object no longer matches its recorded checksum',
    );
  }

  // The recorded checksum always describes the bytes as stored; the plain size
  // and hash of the original go in the `uncompressed_*` columns, so a later
  // decompressed download can be verified without gunzipping anything first.
  const row = await fileRepo.insertFile({
    projectId: project.id,
    deploymentId: null,
    kind: 'artifact',
    storagePath: result.key,
    sizeBytes: result.outputBytes,
    checksum: result.outputChecksum,
    contentType: source.content_type,
    originalName: `${source.original_name ?? basename(source.storage_path)}.gz`,
    parentFileId: source.id,
    compression: 'gzip',
    uncompressedBytes: result.inputBytes,
    uncompressedChecksum: result.inputChecksum,
  });

  return {
    file: toStoredFile(row),
    ratio: result.ratio,
    durationMs: result.durationMs,
    threadId: result.threadId,
  };
}
