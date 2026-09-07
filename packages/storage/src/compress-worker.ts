import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { parentPort, threadId } from 'node:worker_threads';
import { HashingCounter, devNull } from './hashing.js';
import type {
  ChecksumResult,
  CompressTask,
  GunzipTask,
  GzipTask,
  TransformResult,
  WorkerResponse,
} from './compress-protocol.js';

/**
 * The compression worker body.
 *
 * `read → sha256 → gzip → sha256 → write`, streamed end to end inside the
 * thread, so a 200 MB archive costs one chunk of memory at a time and both
 * checksums fall out of the pass that was already reading the bytes.
 *
 * This runs on a `worker_threads` thread because gzip plus two sha256 passes is
 * CPU-bound: inline, it would stall every other request for the duration
 * (CLAUDE.md §4). The thread touches only the absolute paths it is handed.
 */

if (!parentPort) {
  throw new Error('compress-worker must be loaded as a worker_threads worker');
}
const port = parentPort;

async function transform(task: GzipTask | GunzipTask): Promise<TransformResult> {
  const started = performance.now();
  const input = new HashingCounter();
  const output = new HashingCounter();
  const codec = task.op === 'gzip' ? createGzip({ level: task.level }) : createGunzip();

  // 'wx' — the pool's caller reserved this temp name; refuse to clobber anything.
  await pipeline(
    createReadStream(task.sourcePath),
    input,
    codec,
    output,
    createWriteStream(task.targetPath, { flags: 'wx' }),
  );

  return {
    inputBytes: input.bytes,
    inputChecksum: input.digest,
    outputBytes: output.bytes,
    outputChecksum: output.digest,
    durationMs: Math.round(performance.now() - started),
    threadId,
  };
}

async function checksum(sourcePath: string): Promise<ChecksumResult> {
  const started = performance.now();
  const input = new HashingCounter();
  await pipeline(createReadStream(sourcePath), input, devNull());

  return {
    inputBytes: input.bytes,
    inputChecksum: input.digest,
    durationMs: Math.round(performance.now() - started),
    threadId,
  };
}

async function run(task: CompressTask): Promise<TransformResult | ChecksumResult> {
  switch (task.op) {
    case 'gzip':
    case 'gunzip':
      return transform(task);
    case 'checksum':
      return checksum(task.sourcePath);
  }
}

port.on('message', (task: CompressTask) => {
  void run(task).then(
    (result) => {
      const response: WorkerResponse = { id: task.id, ok: true, result };
      port.postMessage(response);
    },
    (err: unknown) => {
      // Errors cannot be structured-cloned reliably, so send the parts that matter.
      const response: WorkerResponse = {
        id: task.id,
        ok: false,
        error: {
          message: err instanceof Error ? err.message : String(err),
          ...(typeof (err as { code?: string })?.code === 'string'
            ? { code: (err as { code: string }).code }
            : {}),
        },
      };
      port.postMessage(response);
    },
  );
});
