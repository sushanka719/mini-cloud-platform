import { performance } from 'node:perf_hooks';
import { pingDb } from '@forge/db';
import type { DependencyHealth, HealthResponse } from '@forge/shared';
import { pingRedis } from '../lib/redis.js';

const CHECK_TIMEOUT_MS = 3_000;
const startedAt = performance.now();

/** Rejects if `promise` doesn't settle in time, so a hung dep can't hang /health. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} check timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function check(label: string, probe: () => Promise<void>): Promise<DependencyHealth> {
  const start = performance.now();
  try {
    await withTimeout(probe(), CHECK_TIMEOUT_MS, label);
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - start),
      // Driver messages are safe here (no credentials) and this endpoint is how
      // the demo shows Postgres/Redis being down.
      error: err instanceof Error ? err.message : 'unknown error',
    };
  }
}

/**
 * Probes both dependencies in parallel.
 *
 * Split out from `getHealth` for the Phase 9 metrics snapshot, which wants the
 * same two probes without the service/version/uptime envelope — one prober,
 * so the metrics page and `/health` can never disagree about whether Postgres
 * is up.
 */
export async function checkDependencies(): Promise<{
  postgres: DependencyHealth;
  redis: DependencyHealth;
}> {
  const [postgres, redis] = await Promise.all([
    check('postgres', pingDb),
    check('redis', pingRedis),
  ]);
  return { postgres, redis };
}

export async function getHealth(version: string): Promise<HealthResponse> {
  const { postgres, redis } = await checkDependencies();

  return {
    ok: postgres.ok && redis.ok,
    service: 'api',
    version,
    uptimeMs: Math.round(performance.now() - startedAt),
    checks: { postgres, redis },
  };
}
