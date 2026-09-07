import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { Readable } from 'node:stream';
import { env } from '@forge/config';
import { badRequest, type StoredFile } from '@forge/shared';
import { sourceKey } from '@forge/storage';
import { fileRepo, type ProjectRow } from '@forge/db';
import { objectStore } from '../lib/object-store.js';
import { toStoredFile } from './serializers.js';

/**
 * Streamed source intake.
 *
 * The bytes go from the request socket straight into the object store, which
 * stages them in a temp file and renames on success — so a rejected or
 * interrupted upload leaves no object and no row (see `LocalObjectStore.put`).
 * Nothing is buffered: a 50 MiB upload costs one chunk of memory at a time.
 */

/** Extensions we accept for a source archive. */
const ALLOWED_EXTENSIONS = new Set(['.zip', '.tar', '.gz', '.tgz']);

/**
 * The client filename is never used to build a key — only to read an extension
 * and to display later. The stored object name is a fresh uuid.
 */
function safeExtension(filename: string): string {
  const ext = extname(filename).toLowerCase();
  if (!ext) return '.zip';
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw badRequest(
      'UNSUPPORTED_FILE_TYPE',
      `Unsupported archive type "${ext}". Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
    );
  }
  return ext;
}

export type UploadResult = { file: StoredFile; sizeBytes: number; checksum: string };

export async function storeProjectSource(
  project: ProjectRow,
  upload: {
    stream: Readable;
    filename: string;
    mimetype: string;
    /**
     * Reports whether the transport layer silently cut the stream short
     * (@fastify/multipart's own fileSize limit). Checked before the object is
     * committed, so a truncated archive never becomes a usable `files` row.
     */
    isTruncated?: () => boolean;
  },
): Promise<UploadResult> {
  const objectName = `${randomUUID()}${safeExtension(upload.filename)}`;
  // Every segment is a uuid or a fixed literal — no user input reaches the key.
  const key = sourceKey(project.org_id, project.id, objectName);

  const stored = await objectStore.put(key, upload.stream, {
    limitBytes: env.MAX_UPLOAD_BYTES,
    beforeCommit: () => {
      if (upload.isTruncated?.()) {
        throw badRequest('UPLOAD_TOO_LARGE', 'Upload exceeded the maximum allowed size');
      }
    },
  });

  const row = await fileRepo.insertFile({
    projectId: project.id,
    deploymentId: null,
    kind: 'source',
    storagePath: stored.key,
    sizeBytes: stored.sizeBytes,
    checksum: stored.checksum,
    contentType: upload.mimetype || null,
    originalName: upload.filename.slice(0, 255),
  });

  return { file: toStoredFile(row), sizeBytes: stored.sizeBytes, checksum: stored.checksum };
}
