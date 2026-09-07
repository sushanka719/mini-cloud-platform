import { AppError } from '@forge/shared';
import type { LocalObjectStore } from './local-object-store.js';
import { runCompressionTask } from './compress-pool.js';

/**
 * Key-level compression: the main thread does key validation, symlink-resolved
 * read paths and the staged write plus commit; the thread does the CPU.
 *
 * The split is what makes this safe to call from a request handler. By the time
 * a task is posted, the only things crossing the thread boundary are two
 * absolute paths already proven to be inside the storage root — the worker has
 * no notion of keys, roots or the database, so it cannot be talked into
 * touching anything else.
 */

export type CompressionResult = {
  /** Key of the object that was written. */
  key: string;
  inputBytes: number;
  inputChecksum: string;
  outputBytes: number;
  outputChecksum: string;
  /** outputBytes / inputBytes — 0.24 means "24% of the original". */
  ratio: number;
  durationMs: number;
  threadId: number;
};

export type GzipOptions = {
  /** zlib level 1–9; the app injects its configured default. */
  level?: number;
};

const DEFAULT_LEVEL = 6;

function ratioOf(inputBytes: number, outputBytes: number): number {
  // An empty input has no meaningful ratio; 1 reads as "no saving" rather than
  // as a division-by-zero Infinity landing in an API response.
  return inputBytes === 0 ? 1 : outputBytes / inputBytes;
}

async function transformObject(
  store: LocalObjectStore,
  op: 'gzip' | 'gunzip',
  sourceKey: string,
  targetKey: string,
  level: number,
): Promise<CompressionResult> {
  const sourcePath = await store.resolveExistingKey(sourceKey);
  return transformPath(store, op, sourcePath, targetKey, level);
}

async function transformPath(
  store: LocalObjectStore,
  op: 'gzip' | 'gunzip',
  sourcePath: string,
  targetKey: string,
  level: number,
): Promise<CompressionResult> {
  const staged = await store.beginStagedWrite(targetKey);

  try {
    const result =
      op === 'gzip'
        ? await runCompressionTask({
            op: 'gzip',
            sourcePath,
            targetPath: staged.tempPath,
            level,
          })
        : await runCompressionTask({
            op: 'gunzip',
            sourcePath,
            targetPath: staged.tempPath,
          });

    const committed = await staged.commit();
    // The rename is the source of truth for what a caller can now read back.
    if (committed.sizeBytes !== result.outputBytes) {
      throw new AppError(
        'OBJECT_SIZE_DRIFT',
        500,
        `Committed object is ${committed.sizeBytes} bytes but the worker wrote ${result.outputBytes}`,
      );
    }

    return {
      key: staged.key,
      inputBytes: result.inputBytes,
      inputChecksum: result.inputChecksum,
      outputBytes: result.outputBytes,
      outputChecksum: result.outputChecksum,
      ratio: ratioOf(result.inputBytes, result.outputBytes),
      durationMs: result.durationMs,
      threadId: result.threadId,
    };
  } catch (err) {
    // A failed transform must leave no half-written object; the temp file is
    // the only thing that ever existed, so removing it is the whole rollback.
    await staged.abort();
    throw err;
  }
}

/**
 * Gzips a stored object into a new one, on a worker thread.
 *
 * `inputChecksum` is the hash the worker computed while *reading* the source,
 * which makes it a free integrity check against the checksum recorded at upload
 * time — see `artifact-service.compressProjectFile`.
 */
export function gzipObject(
  store: LocalObjectStore,
  sourceKey: string,
  targetKey: string,
  options: GzipOptions = {},
): Promise<CompressionResult> {
  return transformObject(store, 'gzip', sourceKey, targetKey, options.level ?? DEFAULT_LEVEL);
}

/**
 * Gzips a file that is **not** in the object store into one that is.
 *
 * The caller vouches for `sourcePath`. That is the whole difference from
 * `gzipObject`, which derives the path from a key and so proves containment
 * itself: here the file lives under `BUILD_ROOT`, not `STORAGE_ROOT`, and the
 * proof is the build sandbox's own `resolveInside()` rather than this
 * package's. The worker uses it to turn a build context tarball into the
 * deployment's stored artifact without first copying it into the store —
 * which for a `node_modules` tree is a copy worth not making twice.
 *
 * The write side is unchanged: `targetKey` still goes through key validation
 * and the staged-then-renamed commit.
 */
export function gzipPathToObject(
  store: LocalObjectStore,
  sourcePath: string,
  targetKey: string,
  options: GzipOptions = {},
): Promise<CompressionResult> {
  return transformPath(store, 'gzip', sourcePath, targetKey, options.level ?? DEFAULT_LEVEL);
}

/**
 * Inflates a gzip object back into a stored object. The streaming download path
 * gunzips on the fly instead; this is for producing a materialised copy, e.g.
 * unpacking a source archive before a build.
 */
export function gunzipObject(
  store: LocalObjectStore,
  sourceKey: string,
  targetKey: string,
): Promise<CompressionResult> {
  return transformObject(store, 'gunzip', sourceKey, targetKey, DEFAULT_LEVEL);
}

export type ChecksumOutcome = {
  key: string;
  sizeBytes: number;
  checksum: string;
  durationMs: number;
  threadId: number;
};

/**
 * Re-hashes a stored object without writing anything — how you prove bytes on
 * disk still match what the `files` row claims.
 */
export async function checksumObject(
  store: LocalObjectStore,
  key: string,
): Promise<ChecksumOutcome> {
  const sourcePath = await store.resolveExistingKey(key);
  const result = await runCompressionTask({ op: 'checksum', sourcePath });

  return {
    key,
    sizeBytes: result.inputBytes,
    checksum: result.inputChecksum,
    durationMs: result.durationMs,
    threadId: result.threadId,
  };
}
