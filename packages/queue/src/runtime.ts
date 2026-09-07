import type { JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { closeRedis } from './connection.js';

/**
 * Configuration and lifetime shared by every queue in the package.
 *
 * Extracted when the second queue arrived (`container-actions`, Phase 7): the
 * Redis URL, the operation deadline, the default job options and the set of
 * connections BullMQ borrowed but will not close are properties of *the
 * package*, not of one queue. Keeping them here is what stops two queues from
 * drifting apart on retry behaviour or leaking a socket each on shutdown.
 */

export type QueueConfig = {
  redisUrl: string;
  /**
   * Deadline for a single producer-side queue operation. BullMQ's connections
   * must use `maxRetriesPerRequest: null` (blocking commands would otherwise be
   * aborted), which means a command issued while Redis is down waits forever.
   * A producer must not: an HTTP request has to fail visibly instead of
   * hanging (CLAUDE.md §10).
   */
  operationTimeoutMs?: number;
  /**
   * BullMQ attempts per job (Phase 8). The budget applies to *retryable*
   * failures only: the worker throws `UnrecoverableError` for a failure no
   * retry could fix, which ends the job at whatever attempt it is on.
   */
  attempts?: number;
  /** Base delay for exponential backoff between attempts, in ms. */
  backoffMs?: number;
  /** How many completed/failed jobs BullMQ keeps for inspection. */
  keepCompleted?: number;
  keepFailed?: number;
  /** How many exhausted jobs `deployments-dlq` keeps. */
  deadLetterKeep?: number;
};

let config: QueueConfig | null = null;

export function configureQueue(next: QueueConfig): void {
  config = next;
}

export function requireConfig(): QueueConfig {
  if (!config) {
    throw new Error('@forge/queue is not configured — call configureQueue({ redisUrl }) at boot');
  }
  return config;
}

export class QueueTimeoutError extends Error {
  constructor(operation: string, ms: number) {
    super(`Queue operation "${operation}" did not complete within ${ms}ms`);
    this.name = 'QueueTimeoutError';
  }
}

/** Bounds one queue command; see `operationTimeoutMs` above. */
export async function withDeadline<T>(operation: string, work: Promise<T>): Promise<T> {
  const ms = config?.operationTimeoutMs ?? 5_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new QueueTimeoutError(operation, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function defaultJobOptions(cfg: QueueConfig, overrides: JobsOptions = {}): JobsOptions {
  return {
    attempts: cfg.attempts ?? 1,
    backoff: { type: 'exponential', delay: cfg.backoffMs ?? 5_000 },
    // Keep a bounded history so the dashboard/queue stats stay meaningful
    // without Redis growing forever.
    removeOnComplete: { count: cfg.keepCompleted ?? 200 },
    removeOnFail: { count: cfg.keepFailed ?? 500 },
    ...overrides,
  };
}

/**
 * Connections handed to BullMQ Workers/QueueEvents. BullMQ does not close a
 * connection it did not create, so we keep them here and close them in
 * `closeQueue()` — otherwise a worker's graceful shutdown leaks a socket.
 */
const borrowed = new Set<Redis>();

export function trackBorrowed(connection: Redis): Redis {
  borrowed.add(connection);
  return connection;
}

export async function closeBorrowed(): Promise<void> {
  const current = [...borrowed];
  borrowed.clear();
  await Promise.allSettled(current.map((client) => closeRedis(client)));
}
