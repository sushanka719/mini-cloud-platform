import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { AppError } from '@forge/shared';
import type {
  CompressRequest,
  CompressTask,
  ResultFor,
  WorkerResponse,
} from './compress-protocol.js';

/**
 * A fixed-size pool of compression threads.
 *
 * Three properties matter here:
 *
 * - **Lazy.** Threads are spawned on first use, so a process that never
 *   compresses never pays for one. That is why the worker can call
 *   `closeCompressionPool()` in its shutdown path without ever having spawned
 *   anything.
 * - **Bounded.** At most `size` threads, with a FIFO queue behind them. gzip is
 *   CPU-bound, so more threads than cores makes every task slower, not faster.
 * - **Survivable.** A thread that dies takes down only the task it was running;
 *   its slot is dropped and the next task spawns a replacement.
 */

type Pending = {
  task: CompressTask;
  resolve: (result: never) => void;
  reject: (err: unknown) => void;
};

type Slot = {
  worker: Worker;
  pending: Pending | null;
};

/** Leave a core for the event loop; never end up with zero threads. */
function defaultSize(): number {
  return Math.max(1, Math.min(2, availableParallelism() - 1));
}

const WORKER_URL = new URL('./compress-worker.js', import.meta.url);

let poolSize = defaultSize();
let nextTaskId = 1;
let draining = false;
const slots: Slot[] = [];
const queue: Pending[] = [];
const drainWaiters: Array<() => void> = [];

export type CompressionPoolStats = {
  /** Configured maximum. */
  size: number;
  /** Threads actually spawned so far. */
  workers: number;
  busy: number;
  queued: number;
};

/**
 * Sets the thread ceiling. This package does not read the environment
 * (ARCHITECTURE §9 allows `storage → shared` only), so the app that boots it
 * injects the size — see `apps/api/src/lib/object-store.ts`.
 */
export function configureCompressionPool(options: { size?: number }): void {
  if (options.size !== undefined) {
    if (!Number.isInteger(options.size) || options.size < 1) {
      throw new Error(`Invalid compression pool size: ${options.size}`);
    }
    poolSize = options.size;
  }
}

export function compressionPoolStats(): CompressionPoolStats {
  return {
    size: poolSize,
    workers: slots.length,
    busy: slots.filter((slot) => slot.pending !== null).length,
    queued: queue.length,
  };
}

function settleDrain(): void {
  if (queue.length > 0 || slots.some((slot) => slot.pending !== null)) return;
  while (drainWaiters.length > 0) drainWaiters.pop()?.();
}

/** Drops a dead or terminated slot and fails whatever it was running. */
function dropSlot(slot: Slot, err: unknown): void {
  const index = slots.indexOf(slot);
  if (index !== -1) slots.splice(index, 1);
  const pending = slot.pending;
  slot.pending = null;
  if (pending) pending.reject(err);
  settleDrain();
}

function spawnSlot(): Slot {
  const worker = new Worker(WORKER_URL);
  const slot: Slot = { worker, pending: null };

  worker.on('message', (response: WorkerResponse) => {
    const pending = slot.pending;
    // A response with no matching request means the protocol drifted; ignoring
    // it would hide that, so fail loudly rather than silently.
    if (!pending || pending.task.id !== response.id) {
      dropSlot(slot, new Error(`Compression worker replied to unknown task ${response.id}`));
      void worker.terminate();
      return;
    }
    slot.pending = null;
    if (response.ok) {
      (pending.resolve as (value: unknown) => void)(response.result);
    } else {
      pending.reject(
        new AppError(
          response.error.code ?? 'COMPRESSION_FAILED',
          500,
          `Compression worker failed: ${response.error.message}`,
        ),
      );
    }
    dispatch();
    settleDrain();
  });

  worker.on('error', (err) => dropSlot(slot, err));
  // `dropSlot` only surfaces this if the thread died mid-task; a clean exit with
  // no task in flight is `terminate()` doing its job.
  worker.on('exit', (code) => {
    dropSlot(
      slot,
      new AppError('COMPRESSION_WORKER_EXITED', 500, `Compression worker exited with code ${code}`),
    );
  });

  // Deliberately not `unref()`d: an idle thread keeping the process alive is
  // the lesser evil next to the process exiting while a gzip is still running.
  // Both apps call `closeCompressionPool()` in their shutdown path.
  slots.push(slot);
  return slot;
}

function dispatch(): void {
  while (queue.length > 0) {
    let slot = slots.find((candidate) => candidate.pending === null);
    if (!slot) {
      if (slots.length >= poolSize) return; // at capacity — wait for a response
      slot = spawnSlot();
    }
    const pending = queue.shift();
    if (!pending) return;
    slot.pending = pending;
    slot.worker.postMessage(pending.task);
  }
}

/**
 * Queues one task and resolves with its result. The op determines the result
 * shape via `ResultFor<T>`, so callers need no casts.
 */
export function runCompressionTask<T extends CompressRequest>(request: T): Promise<ResultFor<T>> {
  if (draining) {
    return Promise.reject(
      new AppError('COMPRESSION_POOL_CLOSING', 503, 'The compression pool is shutting down'),
    );
  }

  const task = { ...request, id: nextTaskId++ } as CompressTask;
  return new Promise<ResultFor<T>>((resolve, reject) => {
    queue.push({ task, resolve: resolve as (result: never) => void, reject });
    dispatch();
  });
}

/**
 * Waits for in-flight work to finish, then terminates every thread.
 *
 * Shutdown order matters: the API closes this before its Redis and Postgres
 * handles, because a running gzip touches only the filesystem and finishing it
 * is cheaper than losing the artifact. New tasks are refused while draining.
 */
export async function closeCompressionPool(): Promise<void> {
  if (slots.length === 0 && queue.length === 0) return;

  draining = true;
  try {
    await new Promise<void>((resolveDrain) => {
      drainWaiters.push(resolveDrain);
      settleDrain();
    });
    // Copy first: terminating fires 'exit', which splices `slots`.
    await Promise.allSettled([...slots].map((slot) => slot.worker.terminate()));
    slots.length = 0;
  } finally {
    // Leave the pool usable again — a dev watch reload re-imports this module
    // in the same process.
    draining = false;
  }
}
