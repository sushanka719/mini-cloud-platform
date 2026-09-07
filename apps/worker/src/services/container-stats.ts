import { REDIS_KEYS, containerStatsSchema, type ContainerStats } from '@forge/shared';
import { env } from '@forge/config';
import { getRedis } from '../lib/redis.js';

/**
 * Where a container's sampled stats live.
 *
 * Redis with a TTL, not Postgres: a CPU reading is worthless a minute later, so
 * expiry is the right storage rule and "no sample" is a meaningful answer the
 * API renders as "—" rather than as a stale number. It also keeps the read side
 * honest — the API is not allowed to call Docker (ARCHITECTURE §9), so a worker
 * writes and the API reads, exactly like the worker heartbeats.
 *
 * The TTL is longer than the sampling interval, so one missed tick does not
 * blank the dashboard, but short enough that a worker going away does.
 */

export async function writeContainerStats(stats: ContainerStats): Promise<void> {
  await getRedis().set(
    REDIS_KEYS.containerStats(stats.deploymentId),
    JSON.stringify(stats),
    'EX',
    env.DOCKER_STATS_TTL_SECONDS,
  );
}

/** Drops a sample when its container is removed, so nothing stale is shown. */
export async function forgetContainerStats(deploymentId: string): Promise<void> {
  try {
    await getRedis().del(REDIS_KEYS.containerStats(deploymentId));
  } catch {
    // The TTL removes it anyway; this only makes the dashboard truthful sooner.
  }
}

/** Reads a sample back. Used by the worker's own tests and diagnostics. */
export async function readContainerStats(deploymentId: string): Promise<ContainerStats | null> {
  const raw = await getRedis().get(REDIS_KEYS.containerStats(deploymentId));
  if (raw === null) return null;
  try {
    const parsed = containerStatsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
