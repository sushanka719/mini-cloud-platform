/**
 * The message contract between the main thread and a compression worker.
 *
 * Both sides import this file, so a change to a task or a result is a type
 * error on both halves rather than a runtime surprise. `ResultFor<T>` is what
 * lets `runCompressionTask()` return the right result shape per op with no cast
 * at the call site.
 *
 * Tasks carry absolute paths and nothing else: the worker knows no keys, no
 * storage root and no database. Validating a key and resolving it to a path is
 * the main thread's job, done before the task is posted.
 */

export type CompressOp = 'gzip' | 'gunzip' | 'checksum';

type BaseTask = {
  /** Correlates a response with its request; assigned by the pool. */
  id: number;
  sourcePath: string;
};

export type GzipTask = BaseTask & {
  op: 'gzip';
  targetPath: string;
  /** zlib level 1–9. */
  level: number;
};

export type GunzipTask = BaseTask & {
  op: 'gunzip';
  targetPath: string;
};

export type ChecksumTask = BaseTask & {
  op: 'checksum';
};

export type CompressTask = GzipTask | GunzipTask | ChecksumTask;

/** A task the pool has not yet stamped with an id. */
export type CompressRequest =
  | Omit<GzipTask, 'id'>
  | Omit<GunzipTask, 'id'>
  | Omit<ChecksumTask, 'id'>;

/**
 * Both checksums come free: the worker hashes the bytes on the way in and on
 * the way out of the transform, in the same streamed pass.
 */
export type TransformResult = {
  inputBytes: number;
  inputChecksum: string;
  outputBytes: number;
  outputChecksum: string;
  /** Wall-clock time spent inside the thread. */
  durationMs: number;
  threadId: number;
};

export type ChecksumResult = {
  inputBytes: number;
  inputChecksum: string;
  durationMs: number;
  threadId: number;
};

export type ResultFor<T extends CompressRequest> = T extends { op: 'checksum' }
  ? ChecksumResult
  : TransformResult;

export type WorkerResponse =
  | { id: number; ok: true; result: TransformResult | ChecksumResult }
  | { id: number; ok: false; error: { message: string; code?: string } };
