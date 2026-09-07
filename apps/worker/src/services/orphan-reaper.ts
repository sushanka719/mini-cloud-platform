import { env, type Logger } from '@forge/config';
import { deploymentRepo } from '@forge/db';
import { getDeploymentJobState } from '@forge/queue';
import { REDIS_KEYS, WORKER_LOST_CODE } from '@forge/shared';
import { logLine, recordStatus } from './deployment-state.js';
import { tryPeriodicLease } from './project-lock.js';
import { workerLiveness } from './worker-liveness.js';

/**
 * The backstop for a deployment whose worker died and whose job the queue also
 * lost (Phase 10).
 *
 * BullMQ's stalled-job recovery is the *good* path: it re-delivers the job and
 * `takeOverAbandoned()` in the processor hands the row to whoever picked it up.
 * This sweep exists for the cases that path cannot reach, and each one is real:
 *
 *  - the job exceeded `DEPLOY_JOB_MAX_STALLED`, so BullMQ failed it **without
 *    running the processor** — nothing told the row;
 *  - the job's record was trimmed, or Redis was flushed, while the row stayed
 *    mid-pipeline in Postgres;
 *  - every worker was down long enough for the queue's own bookkeeping to move
 *    on.
 *
 * In all three the deployment is a spinner on somebody's dashboard that will
 * never stop. Recording it as failed with a reason is strictly better than
 * that, and it re-opens the Retry and Rollback buttons the dashboard already
 * has — so the sweep deliberately does *not* re-enqueue anything itself. One
 * process deciding to silently re-run other processes' builds is a much bigger
 * lever than this problem needs.
 *
 * Three guards keep it from stealing live work:
 *  1. the row has not moved for `ORPHAN_REAP_AFTER_MS`, which is multiples of
 *     the whole stall window;
 *  2. the worker on the row is not heartbeating (and a Redis error reads as
 *     "unknown", never as "dead");
 *  3. BullMQ has no live job for it — `active`/`waiting`/`delayed` means the
 *     queue is still going to recover it and the sweep must stand down.
 *
 * Leader-elected per tick, like the container sampler: N workers all reaping
 * the same row would each try to write the same failure, and while the
 * conditional update makes that safe it would still be N times the work.
 */

/** Job states that mean "the queue still owns this". */
const LIVE_JOB_STATES = new Set(['active', 'waiting', 'waiting-children', 'delayed', 'prioritized']);

export type SweepResult = { scanned: number; reaped: number; skipped: number };

export class OrphanReaper {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly log: Logger) {}

  start(): void {
    if (env.ORPHAN_REAP_INTERVAL_MS === 0) {
      this.log.info('orphan deployment sweep disabled (ORPHAN_REAP_INTERVAL_MS=0)');
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, env.ORPHAN_REAP_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One elected pass. Never throws — it runs on a timer. */
  private async tick(): Promise<void> {
    // Overlap guard: a sweep that reads Postgres and Redis for every candidate
    // can outlast its own interval on a slow laptop.
    if (this.running) return;
    const elected = await tryPeriodicLease(
      REDIS_KEYS.orphanReaperLock,
      env.ORPHAN_REAP_INTERVAL_MS,
    );
    if (!elected) return;

    this.running = true;
    try {
      const result = await this.sweep();
      if (result.reaped > 0) {
        this.log.warn(result, 'reaped deployments whose worker never came back');
      }
    } catch (err) {
      this.log.warn({ err }, 'orphan deployment sweep failed');
    } finally {
      this.running = false;
    }
  }

  async sweep(): Promise<SweepResult> {
    const candidates = await deploymentRepo.listStalledDeployments(env.ORPHAN_REAP_AFTER_MS);
    let reaped = 0;
    let skipped = 0;

    for (const row of candidates) {
      const liveness = await workerLiveness(row.worker_id);
      if (liveness !== 'gone') {
        skipped += 1;
        continue;
      }

      // Ask the queue before touching the row. If BullMQ is going to
      // re-deliver this job, the processor's takeover is the right recovery and
      // this sweep would only race it.
      let state: string | null;
      try {
        state = await getDeploymentJobState(row.id);
      } catch (err) {
        // Cannot tell whether the queue still owns it — so assume it does.
        this.log.warn({ err, deploymentId: row.id }, 'could not read the job state; skipping');
        skipped += 1;
        continue;
      }
      if (state !== null && LIVE_JOB_STATES.has(state)) {
        skipped += 1;
        continue;
      }

      const worker = row.worker_name ?? row.worker_id?.slice(0, 8) ?? 'an unknown worker';
      const message =
        `Worker ${worker} stopped responding during "${row.status}" and the queue has no job ` +
        `for this deployment any more (${state ?? 'no job record'}). Retry it or roll back.`;

      const failed = await deploymentRepo.abandonDeployment(row.id, row.worker_id, {
        code: WORKER_LOST_CODE,
        message,
      });
      if (!failed) {
        // Lost the conditional update: the row moved on between the scan and
        // now, which is the outcome we want.
        skipped += 1;
        continue;
      }

      // The status event is what the dashboard's pipeline reads; the log line
      // is what a person reads. Both, because "failed" on its own does not
      // explain that nothing was wrong with the build.
      await recordStatus(failed, 'failed', `${WORKER_LOST_CODE}: ${message}`);
      await logLine(failed, 'system', message);
      reaped += 1;
      this.log.warn(
        { deploymentId: row.id, previousWorkerId: row.worker_id, stuckAt: row.status, jobState: state },
        'deployment abandoned by a dead worker',
      );
    }

    return { scanned: candidates.length, reaped, skipped };
  }
}
