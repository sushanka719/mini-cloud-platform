import { REDIS_KEYS } from '@forge/shared';
import { getRedis } from '../lib/redis.js';

/**
 * "Is the worker whose id is on this row still alive?"
 *
 * The registry row cannot answer that. A worker killed with SIGKILL never runs
 * `unregister()`, so `workers.status` stays `busy` forever and
 * `current_deployment_id` keeps pointing at a build that stopped minutes ago.
 * The Redis heartbeat key can answer it, because its TTL does the work: three
 * missed beats and it is simply gone (`WORKER_HEARTBEAT_TTL_FACTOR`).
 *
 * This is the same liveness rule `fleet-service.ts` uses to render the fleet
 * page — one signal, read from two places, rather than two signals that can
 * disagree.
 */

/** A Redis error must never be read as "the worker is dead". */
export type Liveness = 'alive' | 'gone' | 'unknown';

export async function workerLiveness(workerId: string | null): Promise<Liveness> {
  // No worker on the row at all: nothing to be alive. Callers treat this the
  // same as `gone`, but the distinction is worth keeping at the call site.
  if (!workerId) return 'gone';
  try {
    const exists = await getRedis().exists(REDIS_KEYS.workerHeartbeat(workerId));
    return exists === 1 ? 'alive' : 'gone';
  } catch {
    // Redis is the liveness signal *and* the queue. If we cannot read it we
    // know nothing, and guessing "gone" here would let a takeover run a
    // deployment a perfectly healthy worker is still building.
    return 'unknown';
  }
}
