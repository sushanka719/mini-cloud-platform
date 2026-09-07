import { deploymentRepo, getDb } from '@forge/db';
import { env, type Logger } from '@forge/config';
import { REDIS_KEYS } from '@forge/shared';
import { sampleContainerStats } from '../docker/container.js';
import { publishContainerMetrics } from '../observability/metrics-sink.js';
import { forgetContainerStats, writeContainerStats } from './container-stats.js';
import { tryPeriodicLease } from './project-lock.js';

/**
 * Samples every running container's CPU and memory into Redis.
 *
 * It lives in the worker because the worker is the only process allowed to talk
 * to Docker. The API reads the samples back out of Redis, which is what puts
 * per-container CPU/memory on the dashboard without the API importing
 * `dockerode` (ARCHITECTURE §9).
 *
 * Leader-elected per tick with a short Redis lease. Without it, N workers would
 * each poll the Docker API for every live container on every tick and write the
 * same document N times — and `/containers/{id}/stats` is not a cheap call.
 * Losing the lease is the normal case for all but one worker, and it does
 * nothing rather than waiting.
 *
 * Phase 9 added the publish half: every sample is also pushed onto the
 * deployment's / project's / org's Pub/Sub channels as `metric` frames, so the
 * dashboard's container gauges move without polling. Not onto the global
 * `metrics` channel — that one is readable by any authenticated member, and a
 * container belongs to one org (see `publishContainerMetrics`).
 */
export class ContainerMonitor {
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(private readonly log: Logger) {}

  start(): void {
    if (env.DOCKER_STATS_INTERVAL_MS === 0) {
      this.log.info('container stats monitor disabled (DOCKER_STATS_INTERVAL_MS=0)');
      return;
    }
    this.#timer = setInterval(() => {
      void this.tick();
    }, env.DOCKER_STATS_INTERVAL_MS);
    this.#timer.unref();
    this.log.info({ intervalMs: env.DOCKER_STATS_INTERVAL_MS }, 'container stats monitor started');
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One sampling pass. Public so a verification script can force one. */
  async tick(): Promise<number> {
    // A slow Docker host must not queue ticks behind each other: skipping is
    // correct for a sampler, where the next reading is as good as this one.
    if (this.#running) return 0;
    this.#running = true;
    try {
      // The lease is a little shorter than the interval, so the next tick is a
      // fresh election rather than a lock this worker keeps forever.
      const lease = Math.max(500, env.DOCKER_STATS_INTERVAL_MS - 250);
      if (!(await tryPeriodicLease(REDIS_KEYS.containerMonitorLock, lease))) return 0;

      const running = await deploymentRepo.listRunningDeployments();
      if (running.length === 0) return 0;

      // One project read per tick, not per container.
      const ports = await this.#appPorts(running.map((row) => row.project_id));

      let sampled = 0;
      for (const row of running) {
        if (!row.container_id) continue;
        try {
          const stats = await sampleContainerStats(
            row.id,
            row.container_id,
            ports.get(row.project_id) ?? 3000,
          );
          if (stats === null) {
            // The container is gone but the row still says it is running. The
            // orphan sweep is the wrong tool (it removes containers, not rows);
            // dropping the stale sample is what this pass can honestly do, and
            // the dashboard then shows "no sample" instead of a frozen number.
            await forgetContainerStats(row.id);
            continue;
          }
          await writeContainerStats(stats);
          // Store first, then publish: the durable-ish answer (the TTL'd
          // document the REST view reads) must exist before anyone is told
          // about it, the same ordering every status transition uses.
          await publishContainerMetrics(stats, row.project_id, row.org_id);
          sampled += 1;
        } catch (err) {
          this.log.debug({ err, deploymentId: row.id }, 'could not sample container stats');
        }
      }
      return sampled;
    } catch (err) {
      // A sampling failure is never allowed to be fatal — it is observability,
      // not the product.
      this.log.warn({ err }, 'container stats tick failed');
      return 0;
    } finally {
      this.#running = false;
    }
  }

  async #appPorts(projectIds: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(projectIds)];
    if (unique.length === 0) return new Map();
    const rows = await getDb()
      .selectFrom('projects')
      .select(['id', 'app_port'])
      .where('id', 'in', unique)
      .execute();
    return new Map(rows.map((row) => [row.id, row.app_port]));
  }
}
