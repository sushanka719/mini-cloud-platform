import { deploymentRepo, metricsRepo } from '@forge/db';
import {
  processScope,
  type ContainerStats,
  type MetricsSnapshot,
  type ProcessMetrics,
} from '@forge/shared';
import { readFleetMetrics } from '../observability/metrics-store.js';
import { readContainerStats } from './container-service.js';
import { readQueueStats } from './fleet-service.js';
import { checkDependencies } from './health-service.js';

/**
 * The metrics snapshot: one consistent read of the whole system.
 *
 * Four sources, and the point of assembling them here rather than letting the
 * dashboard make four calls is that the page then shows queue depth from one
 * instant and deployment counts from another — a mismatch that reads as a bug
 * exactly when someone is debugging a slow deployment.
 *
 *  - **processes** — Redis, one TTL'd document per live API replica and worker.
 *  - **queues** — BullMQ counters, i.e. Redis.
 *  - **deployments** — aggregates computed in Postgres over a trailing window.
 *  - **containers** — the samples a worker's monitor wrote to Redis.
 *
 * Nothing here touches Docker or `child_process` (ARCHITECTURE §9). The API
 * measures *itself* and reads everyone else's numbers out of shared state,
 * which is the same reason the containers view works: the write side is
 * whichever process is allowed to do the work, the read side is any replica.
 */

export type MetricsSnapshotOptions = {
  /**
   * Restrict the deployment aggregates and the container list to one org.
   * Omitted by `/metrics`, which is host-wide.
   */
  orgId?: string | null;
  windowMinutes: number;
  /** This process's instance id, echoed so the reader knows who answered. */
  servedBy: string;
  /**
   * This process's own latest document.
   *
   * Merged over what Redis returns, for one specific failure: if Redis is
   * unreachable the reporter cannot store anything, and a metrics page that
   * shows *nothing* while the process serving it is plainly alive is the least
   * useful possible answer. With this, the replica you are talking to always
   * appears.
   */
  local?: ProcessMetrics | null;
};

export async function getMetricsSnapshot(
  options: MetricsSnapshotOptions,
): Promise<MetricsSnapshot> {
  const orgId = options.orgId ?? null;

  const [processes, queues, deployments, containers, dependencies] = await Promise.all([
    readProcesses(options.local ?? null),
    readQueueStats(),
    metricsRepo.getDeploymentMetrics({ orgId, windowMinutes: options.windowMinutes }),
    readContainers(orgId),
    checkDependencies(),
  ]);

  return {
    at: new Date().toISOString(),
    servedBy: options.servedBy,
    processes,
    queues,
    deployments,
    containers,
    dependencies: {
      postgres: { ok: dependencies.postgres.ok, latencyMs: dependencies.postgres.latencyMs },
      redis: { ok: dependencies.redis.ok, latencyMs: dependencies.redis.latencyMs },
    },
  };
}

/**
 * Every reporting process, with this one guaranteed present.
 *
 * The local document *replaces* the stored copy rather than being appended:
 * they are the same process, and the in-memory one is by definition at least
 * as fresh as what it last managed to write.
 */
async function readProcesses(local: ProcessMetrics | null): Promise<ProcessMetrics[]> {
  let stored: ProcessMetrics[] = [];
  try {
    stored = await readFleetMetrics();
  } catch {
    // Redis unreachable. The `local` document below is all we have, and saying
    // so with one card beats failing the page (CLAUDE.md §10).
  }
  if (!local) return stored;

  const id = processScope(local.role, local.instance);
  const merged = stored.filter((process) => processScope(process.role, process.instance) !== id);
  merged.push(local);
  return merged.sort(
    (a, b) => a.role.localeCompare(b.role) || a.instance.localeCompare(b.instance),
  );
}

/**
 * Container samples for the requested scope.
 *
 * Org-scoped for the dashboard, host-wide for the Prometheus scrape. The
 * *Postgres* row set is what defines the scope — Redis holds one key per
 * deployment with no org in it, so filtering by tenant has to happen on the
 * side that knows about tenants. Getting that backwards would put another
 * org's container CPU on your page.
 */
async function readContainers(orgId: string | null): Promise<ContainerStats[]> {
  const rows = orgId
    ? await deploymentRepo.listOrgRunningDeployments(orgId)
    : await deploymentRepo.listRunningDeployments();
  if (rows.length === 0) return [];
  const stats = await readContainerStats(rows.map((row) => row.id));
  // Deployments with no recent sample are omitted rather than reported as
  // zeroes: "no worker has sampled this" and "this container is idle" are
  // different facts and must not render the same.
  return rows.map((row) => stats.get(row.id)).filter((value): value is ContainerStats => value !== undefined);
}
