import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import {
  badRequest,
  notFound,
  type FileKind,
  type StorageUsage,
  type StoredFile,
} from '@forge/shared';
import { compressionPoolStats, projectPrefix } from '@forge/storage';
import type { FileRow, ProjectRow } from '@forge/db';
import {
  deleteFileRow,
  findProjectFile,
  listProjectFileIndex,
  listProjectFiles,
} from '../repositories/file-repository.js';
import { objectStore } from '../lib/object-store.js';
import { toStoredFile } from './serializers.js';

/** Reads/serves/removes objects. Producing them lives in the upload + artifact services. */

export async function getProjectFiles(
  projectId: string,
  kind?: FileKind,
  limit?: number,
): Promise<StoredFile[]> {
  return (await listProjectFiles(projectId, kind, limit)).map(toStoredFile);
}

/** The single lookup, so the project scope can never be forgotten. */
export async function requireProjectFile(projectId: string, fileId: string): Promise<FileRow> {
  const row = await findProjectFile(projectId, fileId);
  if (!row) throw notFound('FILE_NOT_FOUND', 'File not found');
  return row;
}

/**
 * A filename is only ever *displayed*, never used to build a key — but it does
 * go into a response header, so strip control characters, quotes and anything
 * that could be read as a path.
 */
function safeFilename(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u001f\u007f"\\/]/g, '_')
    .trim();
  return cleaned.slice(0, 200) || 'download';
}

export type DownloadPayload = {
  row: FileRow;
  stream: Readable;
  /** null when the length is not known ahead of time (streamed gunzip). */
  contentLength: number | null;
  contentType: string;
  filename: string;
  /** sha256 of exactly the bytes this response will send, if we know it. */
  checksum: string | null;
  /** Size on disk, so a caller can spot drift from the recorded size. */
  storedBytes: number;
  decompressed: boolean;
};

/**
 * Streams a stored object back out. Nothing is read into memory: the fs read
 * stream is handed to Fastify, which pipes it to the socket, so a slow client
 * throttles the disk read instead of filling the heap (CONVENTIONS §6).
 *
 * `decompress` unpacks a gzip artifact on the way out, which is how the round
 * trip is proven byte-identical: the response hashes to the artifact's recorded
 * `uncompressed_checksum`.
 */
export async function openDownload(
  project: ProjectRow,
  fileId: string,
  options: { decompress?: boolean } = {},
): Promise<DownloadPayload> {
  const row = await requireProjectFile(project.id, fileId);

  const stat = await objectStore.head(row.storage_path);
  if (!stat) {
    throw notFound('OBJECT_MISSING', 'The object is indexed but missing from the object store');
  }

  const source = await objectStore.get(row.storage_path);
  const displayName = safeFilename(row.original_name ?? basename(row.storage_path));

  if (!options.decompress) {
    return {
      row,
      stream: source,
      contentLength: stat.sizeBytes,
      contentType:
        row.compression === 'gzip'
          ? 'application/gzip'
          : (row.content_type ?? 'application/octet-stream'),
      filename: displayName,
      checksum: row.checksum,
      storedBytes: stat.sizeBytes,
      decompressed: false,
    };
  }

  if (row.compression !== 'gzip') {
    source.destroy();
    throw badRequest('NOT_COMPRESSED', 'This object is not gzip-compressed');
  }

  // zlib streams run on the libuv threadpool, so inflating during a download
  // does not block the event loop; whole-object compression is the path that
  // goes to a worker thread (see artifact-service).
  const stream = source.pipe(createGunzip());
  // A corrupt gzip must tear down the fs read too, not leak the handle.
  stream.on('error', () => source.destroy());

  return {
    row,
    stream,
    contentLength: row.uncompressed_bytes === null ? null : Number(row.uncompressed_bytes),
    contentType: row.content_type ?? 'application/octet-stream',
    filename: displayName.replace(/\.gz$/i, ''),
    checksum: row.uncompressed_checksum,
    storedBytes: stat.sizeBytes,
    decompressed: true,
  };
}

/**
 * Removes the object first, then its index row. If the second step fails the
 * row shows up as `missingCount` in the usage report rather than pointing at
 * bytes that are already gone.
 */
export async function deleteProjectFile(
  project: ProjectRow,
  fileId: string,
): Promise<{ objectDeleted: boolean }> {
  const row = await requireProjectFile(project.id, fileId);
  const objectDeleted = await objectStore.delete(row.storage_path);
  await deleteFileRow(project.id, fileId);
  return { objectDeleted };
}

/**
 * Reconciles what is on disk with what the DB thinks is there. Walking the
 * store (rather than summing `files.size_bytes`) is the point: an object with
 * no row, or a row with no object, is exactly the drift a crashed upload leaves
 * behind, and it should be visible instead of invisible.
 */
export async function getStorageUsage(project: ProjectRow): Promise<StorageUsage> {
  const prefix = projectPrefix(project.org_id, project.id);
  const [objects, rows] = await Promise.all([
    objectStore.list(prefix),
    listProjectFileIndex(project.id),
  ]);

  const byPath = new Map(rows.map((row) => [row.storage_path, row]));
  const byKind: StorageUsage['byKind'] = {};
  let totalBytes = 0;
  let orphanCount = 0;
  let orphanBytes = 0;

  for (const object of objects) {
    totalBytes += object.sizeBytes;
    const row = byPath.get(object.key);
    // For an orphan there is no row to ask, so fall back to the layout.
    const kind = row?.kind ?? inferKind(object.key);
    const bucket = (byKind[kind] ??= { objectCount: 0, totalBytes: 0 });
    bucket.objectCount += 1;
    bucket.totalBytes += object.sizeBytes;
    if (!row) {
      orphanCount += 1;
      orphanBytes += object.sizeBytes;
    }
  }

  const onDisk = new Set(objects.map((object) => object.key));
  const missingCount = rows.filter((row) => !onDisk.has(row.storage_path)).length;
  const pool = compressionPoolStats();

  return {
    objectCount: objects.length,
    totalBytes,
    byKind,
    orphanCount,
    orphanBytes,
    missingCount,
    compression: {
      threads: pool.workers,
      busy: pool.busy,
      queued: pool.queued,
      poolSize: pool.size,
    },
  };
}

function inferKind(key: string): string {
  if (key.includes('/artifacts/')) return 'artifact';
  if (key.includes('/logs/')) return 'log';
  if (key.includes('/sources/')) return 'source';
  return 'unknown';
}
