import { sql } from 'kysely';
import {
  DEPLOYMENT_PIPELINE_STAGES,
  round,
  type DeploymentMetrics,
  type DeploymentStatus,
  type DurationStats,
  type FailureBucket,
} from '@forge/shared';
import { getDb } from '../client.js';

/**
 * Deployment aggregates for the metrics dashboard (Phase 9).
 *
 * Every number here is computed **in Postgres, on read**. Nothing new is
 * written: `duration_ms`, `attempt`, `dead_lettered_at` and `error_code` have
 * been on `deployments` since Phases 4–8, so the charts are a query rather
 * than a second write path that could disagree with the rows.
 *
 * That choice has a cost worth naming: these are `GROUP BY`s over a trailing
 * window, so they get slower as the table grows and they are *not* free to
 * poll every 200 ms. The dashboard polls them every few seconds and takes the
 * fast-moving numbers (CPU, queue depth) over the WebSocket instead — which is
 * the whole reason the snapshot endpoint and the `metrics` topic are separate
 * things.
 *
 * Windowed rather than all-time, because an all-time success rate stops moving
 * after a few hundred deployments and is useless as a live signal.
 */

/** Statuses that mean "still in the pipeline" — everything before `live`. */
const IN_FLIGHT_STATUSES: readonly DeploymentStatus[] = DEPLOYMENT_PIPELINE_STAGES.filter(
  (status) => status !== 'live',
);

export type DeploymentStatsOptions = {
  /** Restrict to one org. Omitted for the process-wide `/metrics` scrape. */
  orgId?: string | null;
  windowMinutes: number;
};

type StatusCountRow = {
  status: DeploymentStatus;
  count: number;
  retried: number;
  dead_lettered: number;
};

type DurationRow = {
  duration_count: number;
  duration_mean: number | null;
  duration_p50: number | null;
  duration_p95: number | null;
  duration_max: number | null;
  succeeded: number;
};

type FailureRow = { code: string | null; count: number };

/**
 * How far back to look, as a SQL fragment.
 *
 * `created_at`, not `finished_at`: the question the dashboard asks is "what has
 * this system been asked to do lately", and a deployment that is still
 * building has no `finished_at` yet but is very much part of the answer.
 */
function windowClause(windowMinutes: number) {
  return sql`d.created_at >= now() - (${windowMinutes} * interval '1 minute')`;
}

/**
 * `AND d.org_id = $1`, or nothing.
 *
 * A fragment rather than two copies of each query: the org-scoped and global
 * forms differ by exactly this line, and keeping them as one query is what
 * stops the dashboard's numbers and the Prometheus scrape from drifting apart.
 */
function orgClause(orgId: string | null | undefined) {
  return orgId ? sql`and d.org_id = ${orgId}::uuid` : sql``;
}

export async function getDeploymentMetrics(
  options: DeploymentStatsOptions,
): Promise<DeploymentMetrics> {
  const { windowMinutes } = options;
  const orgId = options.orgId ?? null;
  const db = getDb();
  const period = windowClause(windowMinutes);
  const org = orgClause(orgId);

  const [statuses, durations, failures] = await Promise.all([
    /**
     * One row per status present in the window, carrying the two per-row flags
     * that only make sense as a total. Grouping rather than a dozen
     * `count(*) FILTER (…)` columns: a new status in the enum then needs no
     * change here at all.
     */
    sql<StatusCountRow>`
      select
        d.status,
        count(*)::int as count,
        count(*) filter (where d.attempt > 1)::int as retried,
        count(*) filter (where d.dead_lettered_at is not null)::int as dead_lettered
      from deployments d
      where ${period} ${org}
      group by d.status
    `.execute(db),

    /**
     * Durations and the success count, over the same window.
     *
     * `percentile_cont` interpolates between the two neighbouring samples,
     * which is right for a continuous quantity like wall-clock duration (and
     * wrong for the request-latency reservoir in `@forge/metrics`, which
     * reports a value some request actually experienced). NULL durations —
     * deployments still running — are ignored by the aggregate rather than
     * counted as zero.
     *
     * "Succeeded" is `EXISTS (a live status event)`, **not** `status = 'live'`.
     * A deployment that went live and was later replaced now reads
     * `rolled_back` or `stopped`, and calling that a failure would make every
     * rollback demo look like an outage. The timeline is the durable proof it
     * ever worked — the same rule `listRollbackTargets` uses.
     */
    sql<DurationRow>`
      select
        count(d.duration_ms)::int as duration_count,
        avg(d.duration_ms)::float8 as duration_mean,
        percentile_cont(0.5) within group (order by d.duration_ms)::float8 as duration_p50,
        percentile_cont(0.95) within group (order by d.duration_ms)::float8 as duration_p95,
        max(d.duration_ms)::float8 as duration_max,
        count(*) filter (
          where exists (
            select 1 from deployment_events e
            where e.deployment_id = d.id and e.type = 'status' and e.status = 'live'
          )
        )::int as succeeded
      from deployments d
      where ${period} ${org}
    `.execute(db),

    /**
     * Failures by `error_code` — the histogram ARCHITECTURE §6 asks for.
     *
     * Bounded to the top slice: the codes are a closed set today, but the
     * column is free text and an unbounded `GROUP BY` over user-influenced
     * values is a response whose size an attacker chooses.
     */
    sql<FailureRow>`
      select d.error_code as code, count(*)::int as count
      from deployments d
      where ${period} ${org} and d.status = 'failed' and d.error_code is not null
      group by d.error_code
      order by count(*) desc, d.error_code asc
      limit 15
    `.execute(db),
  ]);

  const byStatus: Record<string, number> = {};
  let total = 0;
  let retried = 0;
  let deadLettered = 0;
  let inFlight = 0;
  for (const row of statuses.rows) {
    byStatus[row.status] = row.count;
    total += row.count;
    retried += row.retried;
    deadLettered += row.dead_lettered;
    if (IN_FLIGHT_STATUSES.includes(row.status)) inFlight += row.count;
  }

  const duration = durations.rows[0];
  const succeeded = duration?.succeeded ?? 0;
  const failed = byStatus.failed ?? 0;
  const settled = total - inFlight;

  const durationStats: DurationStats = {
    count: duration?.duration_count ?? 0,
    meanMs: nullableRound(duration?.duration_mean),
    p50Ms: nullableRound(duration?.duration_p50),
    p95Ms: nullableRound(duration?.duration_p95),
    maxMs: nullableRound(duration?.duration_max),
  };

  const failuresByCode: FailureBucket[] = failures.rows.map((row) => ({
    code: row.code ?? 'UNKNOWN',
    count: row.count,
  }));

  return {
    windowMinutes,
    total,
    byStatus,
    succeeded,
    failed,
    retried,
    deadLettered,
    inFlight,
    // null, not 0, when nothing has settled: a rate over an empty set is not
    // "0% successful", and a chart that renders it as such reads as an outage.
    successRate: settled > 0 ? round(Math.min(1, succeeded / settled), 4) : null,
    duration: durationStats,
    failuresByCode,
  };
}

/**
 * `float8` comes back as a JS number, but `avg`/`percentile_cont` over an
 * empty set is NULL — which must stay null rather than becoming 0.
 */
function nullableRound(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return round(value, 0);
}
