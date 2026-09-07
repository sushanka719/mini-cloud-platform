import { Queue, type Job } from 'bullmq';
import {
  DEAD_LETTER_JOB_NAME,
  QUEUE_NAMES,
  deadLetterJobSchema,
  type DeadLetterJob,
  type QueueStats,
} from '@forge/shared';
import type { Redis } from 'ioredis';
import { closeRedis, createRedis } from './connection.js';
import { requireConfig, withDeadline } from './runtime.js';

/**
 * The `deployments-dlq` queue: where a deployment's job goes when its retry
 * budget is spent, or when its failure was one no retry could fix.
 *
 * **Nothing consumes it.** That is the point — it is a parking lot, not a
 * pipeline. A dead-letter queue with a worker on it is just a slower retry
 * loop; what we want is for a failure to *stop*, stay readable, and require a
 * human decision (retry it, roll back, or fix the project).
 *
 * A BullMQ queue rather than a Postgres table because the thing worth keeping
 * is the *job*: its payload, the attempts it burned and the reason it stopped,
 * with a bounded retention BullMQ already implements. The durable half — "this
 * deployment was dead-lettered" — is a column on `deployments`, so the fact
 * survives a Redis flush even when the detail does not.
 *
 * Entries are added with `jobId = <deploymentId>_a<attempt>`, which makes the
 * hop idempotent: two workers racing on a re-delivered final attempt park one
 * entry, and a *later* attempt of the same deployment (a manual retry that
 * also failed) parks a distinct one rather than overwriting the first.
 *
 * The separator is `_a`, not `:` — BullMQ rejects a custom job id containing a
 * colon, because that is the separator in its own Redis key namespace. Found
 * the hard way: the hop failed with "Custom Id cannot contain :" while the
 * Postgres half had already been written, which is exactly the split record
 * the ordering in the caller is now arranged to survive.
 */

let queue: Queue<DeadLetterJob> | null = null;
let queueConnection: Redis | null = null;

export function getDeadLetterQueue(): Queue<DeadLetterJob> {
  if (queue) return queue;
  const cfg = requireConfig();
  queueConnection = createRedis(cfg.redisUrl, 'bullmq');
  queue = new Queue<DeadLetterJob>(QUEUE_NAMES.deploymentsDlq, {
    connection: queueConnection,
    defaultJobOptions: {
      // One attempt and no backoff: an entry here is never executed, so the
      // retry machinery would be meaningless.
      attempts: 1,
      // Never remove on completion — a job that is never processed never
      // completes, and the whole value is that the record stays.
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
  return queue;
}

/**
 * Parks one exhausted deployment.
 *
 * Returns the job so the caller can log its id, or `null` when an entry for
 * this (deployment, attempt) already exists — which is a successful outcome,
 * not a failure: it means the hop already happened.
 */
export async function enqueueDeadLetter(record: DeadLetterJob): Promise<Job<DeadLetterJob> | null> {
  const payload = deadLetterJobSchema.parse(record);
  const jobId = `${payload.deploymentId}_a${String(payload.attempt)}`;
  const q = getDeadLetterQueue();

  const existing = await withDeadline('getDeadLetter', q.getJob(jobId));
  if (existing) return null;

  const job = await withDeadline(
    'addDeadLetter',
    q.add(DEAD_LETTER_JOB_NAME, payload, { jobId }),
  );
  await trim(q);
  return job;
}

/**
 * Keeps the parking lot bounded.
 *
 * `removeOnComplete`/`removeOnFail` can't do it — they only fire when a job is
 * *processed*, and nothing processes this queue — so the oldest waiting entries
 * are dropped by hand once the queue is over budget. Best-effort: failing to
 * trim must never fail the hop that was trying to record a failure.
 */
async function trim(q: Queue<DeadLetterJob>): Promise<void> {
  const keep = requireConfig().deadLetterKeep ?? 1_000;
  try {
    const waiting = await withDeadline('countDeadLetters', q.getWaitingCount());
    if (waiting <= keep) return;
    // Oldest first: `getJobs` returns waiting jobs in insertion order, so the
    // overflow is the head of the list.
    const overflow = await withDeadline(
      'listDeadLetterOverflow',
      q.getJobs(['waiting'], 0, waiting - keep - 1),
    );
    await Promise.allSettled(overflow.map((job) => job.remove()));
  } catch {
    // Deliberately swallowed — see above.
  }
}

/**
 * Reads parked entries, newest first.
 *
 * They sit in `waiting` because nothing consumes the queue, which is also why
 * the read is a plain range rather than a status filter over several sets.
 */
export async function listDeadLetters(limit: number): Promise<Job<DeadLetterJob>[]> {
  const q = getDeadLetterQueue();
  const jobs = await withDeadline('listDeadLetters', q.getJobs(['waiting'], 0, -1));
  return [...jobs]
    .filter((job): job is Job<DeadLetterJob> => job !== null && job !== undefined)
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .slice(0, limit);
}

/** Discards one entry — the "I have dealt with this" button. */
export async function discardDeadLetter(jobId: string): Promise<boolean> {
  const q = getDeadLetterQueue();
  const job = await withDeadline('getDeadLetter', q.getJob(jobId));
  if (!job) return false;
  await withDeadline('removeDeadLetter', job.remove());
  return true;
}

export async function getDeadLetterStats(): Promise<QueueStats> {
  const q = getDeadLetterQueue();
  const counts = await withDeadline(
    'getDeadLetterCounts',
    q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
  );
  return {
    name: QUEUE_NAMES.deploymentsDlq,
    available: true,
    // `waiting` is the real depth here: an entry is added and never consumed.
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
    paused: false,
  };
}

export async function closeDeadLetterQueue(): Promise<void> {
  const current = queue;
  const connection = queueConnection;
  queue = null;
  queueConnection = null;
  if (current) await current.close();
  await closeRedis(connection);
}
