import type { MigrationBuilder } from 'node-pg-migrate';

export const shorthands: undefined = undefined;

/**
 * Phase 8. Two columns on `deployments`, both about the retry story.
 *
 * `attempt` has existed since Phase 4 and counts the runs; what was missing was
 * the *budget* those runs were spent against and a durable mark saying the
 * budget ran out. Both are on the row rather than derived, for the same reason
 * `status` is denormalized alongside `deployment_events`: the dashboard reads
 * them on every list, and neither Redis (which holds the queue) nor the event
 * timeline is a safe place to look up "how many attempts was this allowed?"
 * months later.
 *
 * Nothing here needs a data migration: existing rows really did run under a
 * budget of one attempt and really were never dead-lettered, so the defaults
 * are the truth rather than a placeholder.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('deployments', {
    /**
     * The retry budget in force when the row was created. Recorded per row so
     * "attempt 2 of 3" keeps meaning the 3 that applied at the time, even after
     * `DEPLOY_JOB_ATTEMPTS` is changed. Default 1 = the Phase 4–7 behaviour.
     */
    max_attempts: { type: 'integer', notNull: true, default: 1 },
    /**
     * When the retry budget was spent and the job was parked in
     * `deployments-dlq`. Nullable because most failures are retried and
     * eventually succeed, or are still retrying.
     */
    dead_lettered_at: { type: 'timestamptz' },
  });

  pgm.addConstraint('deployments', 'deployments_max_attempts_check', {
    check: 'max_attempts BETWEEN 1 AND 100',
  });

  /**
   * The rollback-candidate lookup: a project's deployments that were serving
   * and are not now, newest first.
   *
   * Partial, because that predicate is the whole query and the set is a small
   * fraction of the table — every `failed` and every in-flight row is excluded
   * from the index rather than scanned and discarded.
   */
  pgm.sql(`
    CREATE INDEX idx_deployments_rollback_targets
      ON deployments (project_id, created_at DESC)
      WHERE status IN ('stopped', 'rolled_back')
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP INDEX IF EXISTS idx_deployments_rollback_targets');
  pgm.dropConstraint('deployments', 'deployments_max_attempts_check', { ifExists: true });
  pgm.dropColumns('deployments', ['max_attempts', 'dead_lettered_at']);
}
