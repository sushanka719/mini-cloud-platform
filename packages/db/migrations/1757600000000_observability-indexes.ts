import type { MigrationBuilder } from 'node-pg-migrate';

export const shorthands: undefined = undefined;

/**
 * Phase 9. Indexes only — no new columns, no data migration.
 *
 * Every number the metrics dashboard charts already exists on `deployments`
 * (`duration_ms`, `attempt`, `dead_lettered_at`, `error_code`) or in
 * `deployment_events`. What was missing was a way to read them *by org over a
 * trailing window* without a sequential scan: the existing indexes are
 * `(project_id, created_at DESC)`, `status` and `worker_id`, none of which
 * helps a query whose predicate is `org_id = … AND created_at >= …`.
 *
 * Two indexes, because the observability queries come in two shapes:
 *
 *  - the org-scoped dashboard snapshot — `(org_id, created_at DESC)`;
 *  - the global Prometheus scrape, which has no org predicate at all and
 *    filters on `created_at` alone.
 *
 * `created_at DESC` matches the window predicate's direction, so the planner
 * can stop as soon as it walks past the window's edge instead of filtering the
 * whole index.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('CREATE INDEX idx_deployments_org_created ON deployments (org_id, created_at DESC)');
  pgm.sql('CREATE INDEX idx_deployments_created ON deployments (created_at DESC)');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP INDEX IF EXISTS idx_deployments_created');
  pgm.sql('DROP INDEX IF EXISTS idx_deployments_org_created');
}
