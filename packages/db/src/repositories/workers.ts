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

export async function listWorkers(limit = 50): Promise<WorkerRow[]> {
  return getDb()
    .selectFrom('workers')
    .selectAll()
    .orderBy('last_heartbeat_at', 'desc')
    .limit(limit)
    .execute();
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
