import { sql } from 'kysely';
import { getDb } from '../client.js';
import type { WorkerRow } from '../types.js';
import type { WorkerStatus } from '@forge/shared';

/**
 * The worker registry: one row per worker process, written by the worker and
 * read by every API replica. Live heartbeats also go to Redis with a TTL — the
 * table is the registry/history, Redis is the liveness signal (DATA_MODEL §3).
 */

export async function registerWorker(input: {
  name: string;
  host: string;
  pid: number;
  concurrency: number;
}): Promise<WorkerRow> {
  return getDb()
    .insertInto('workers')
    .values({
      name: input.name,
      host: input.host,
      pid: input.pid,
      concurrency: input.concurrency,
      status: 'idle',
      last_heartbeat_at: sql`now()`,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function heartbeatWorker(
  workerId: string,
  status: WorkerStatus,
  currentDeploymentId: string | null,
): Promise<void> {
  await getDb()
    .updateTable('workers')
    .set({
      status,
      current_deployment_id: currentDeploymentId,
      last_heartbeat_at: sql`now()`,
    })
    .where('id', '=', workerId)
    .execute();
}

export async function setWorkerStatus(workerId: string, status: WorkerStatus): Promise<void> {
  await getDb().updateTable('workers').set({ status }).where('id', '=', workerId).execute();
}

/**
 * The fleet view's worker list: **recently seen** workers, not every worker
 * that ever registered.
 *
 * A row per process run is the right history — that is how "which worker ran
 * which deployment" stays answerable months later — but it makes an unfiltered
 * list useless as a live view. Ten phases of development on one laptop had
 * accumulated 38 rows, all but one of them a long-dead process, and the one
 * online worker was somewhere in the middle of them.
 *
 * `seenWithinMs` is a Postgres-side filter on `last_heartbeat_at`, which is
 * safe for the liveness question even though liveness itself lives in Redis: an
 * online worker writes that column every `WORKER_HEARTBEAT_MS` (5s by default),
 * so any window measured in minutes includes every live worker with room to
 * spare. The history is untouched — this narrows a read, not the table.
 */
export async function listWorkers(
  options: { limit?: number; seenWithinMs?: number } = {},
): Promise<WorkerRow[]> {
  const limit = options.limit ?? 50;
  let query = getDb().selectFrom('workers').selectAll();
  if (options.seenWithinMs !== undefined) {
    const seconds = Math.floor(options.seenWithinMs / 1000);
    query = query.where(
      'last_heartbeat_at',
      '>',
      sql<Date>`now() - make_interval(secs => ${seconds})`,
    );
  }
  return query.orderBy('last_heartbeat_at', 'desc').limit(limit).execute();
}

/**
 * Drops registry rows for processes that stopped heartbeating long ago, so the
 * fleet view doesn't accumulate every worker that ever ran on this laptop.
 * Rows still referenced by a deployment survive — the FK is ON DELETE SET NULL,
 * but losing which worker ran which build would erase useful history — so this
 * only removes workers that never claimed anything.
 */
export async function pruneStaleWorkers(olderThanMs: number): Promise<number> {
  const seconds = Math.floor(olderThanMs / 1000);
  const result = await getDb()
    .deleteFrom('workers')
    .where('last_heartbeat_at', '<', sql<Date>`now() - make_interval(secs => ${seconds})`)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('deployments')
            .select('deployments.id')
            .whereRef('deployments.worker_id', '=', 'workers.id'),
        ),
      ),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
