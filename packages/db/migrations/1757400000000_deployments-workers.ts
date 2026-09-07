import type { MigrationBuilder } from 'node-pg-migrate';

export const shorthands: undefined = undefined;

/**
 * Phase 4. The deployment record, its append-only event timeline, and the
 * worker registry — plus the two forward-reference FKs Phases 2 and 3 left
 * unconstrained because `deployments` did not exist yet.
 *
 * Three tables reference each other in a cycle (deployments.worker_id →
 * workers, workers.current_deployment_id → deployments, deployments.
 * parent_deployment_id → deployments), so the columns are created bare and the
 * constraints added afterwards.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('deployment_status', [
    'queued',
    'assigned',
    'cloning',
    'installing',
    'building',
    'creating_container',
    'starting',
    'health_check',
    'live',
    'failed',
    'stopped',
    'rolled_back',
    'canceled',
  ]);
  pgm.createType('worker_status', ['idle', 'busy', 'offline', 'draining']);
  pgm.createType('log_stream', ['stdout', 'stderr', 'system']);

  pgm.createTable('workers', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    status: { type: 'worker_status', notNull: true, default: 'idle' },
    host: { type: 'text' },
    pid: { type: 'integer' },
    // FK added below, once `deployments` exists.
    current_deployment_id: { type: 'uuid' },
    concurrency: { type: 'integer', notNull: true, default: 1 },
    last_heartbeat_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('workers', ['status', 'last_heartbeat_at']);

  pgm.createTable('deployments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'projects(id)', onDelete: 'CASCADE' },
    org_id: { type: 'uuid', notNull: true, references: 'organizations(id)', onDelete: 'CASCADE' },
    status: { type: 'deployment_status', notNull: true, default: 'queued' },
    // Upload projects: the source `files.id`. Git projects: a commit-ish.
    source_ref: { type: 'text' },
    // The stored object this deployment builds from, when there is one.
    source_file_id: { type: 'uuid', references: 'files(id)', onDelete: 'SET NULL' },
    idempotency_key: { type: 'text' },
    attempt: { type: 'integer', notNull: true, default: 0 },
    triggered_by: { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    worker_id: { type: 'uuid', references: 'workers(id)', onDelete: 'SET NULL' },
    // Rollback lineage; FK added below (self-reference on a fresh table).
    parent_deployment_id: { type: 'uuid' },
    image_tag: { type: 'text' },
    container_id: { type: 'text' },
    url: { type: 'text' },
    host_port: { type: 'integer' },
    // Demo hook for the simulated pipeline; Phase 6 replaces it with real work.
    fail_at: { type: 'deployment_status' },
    error_code: { type: 'text' },
    error_message: { type: 'text' },
    queued_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    started_at: { type: 'timestamptz' },
    finished_at: { type: 'timestamptz' },
    duration_ms: { type: 'integer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('deployments', 'deployments_parent_fkey', {
    foreignKeys: {
      columns: 'parent_deployment_id',
      references: 'deployments(id)',
      onDelete: 'SET NULL',
    },
  });
  pgm.addConstraint('deployments', 'deployments_host_port_check', {
    check: 'host_port IS NULL OR host_port BETWEEN 1 AND 65535',
  });

  /**
   * Idempotency (CLAUDE.md §7): unique per (project, source_ref, key).
   *
   * DATA_MODEL.md specifies a plain UNIQUE, but in Postgres two NULLs never
   * collide, so a plain constraint would silently do nothing for the common
   * case (no key) *and* nothing for the case it exists to protect. A partial
   * unique index over `coalesce(source_ref,'')` enforces it exactly when a key
   * was supplied, and leaves keyless deploys free to repeat.
   */
  // Raw SQL: the index is over an expression, which the builder's column
  // helper would quote as an identifier.
  pgm.sql(`
    CREATE UNIQUE INDEX uq_deployments_idempotency
      ON deployments (project_id, coalesce(source_ref, ''), idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `);
  pgm.sql('CREATE INDEX idx_deployments_project ON deployments (project_id, created_at DESC)');
  pgm.createIndex('deployments', 'status', { name: 'idx_deployments_status' });
  pgm.createIndex('deployments', 'worker_id');

  pgm.createTable('deployment_events', {
    // bigint identity: monotonic, so it doubles as the replay cursor.
    id: { type: 'bigint', primaryKey: true, notNull: true, sequenceGenerated: { precedence: 'ALWAYS' } },
    deployment_id: {
      type: 'uuid',
      notNull: true,
      references: 'deployments(id)',
      onDelete: 'CASCADE',
    },
    type: { type: 'text', notNull: true },
    status: { type: 'deployment_status' },
    stream: { type: 'log_stream' },
    message: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('deployment_events', 'deployment_events_type_check', {
    check: "type IN ('status', 'log')",
  });
  // A status event carries a status; a log event carries a stream.
  pgm.addConstraint('deployment_events', 'deployment_events_shape_check', {
    check: `(type = 'status' AND status IS NOT NULL)
            OR (type = 'log' AND stream IS NOT NULL)`,
  });
  pgm.createIndex('deployment_events', ['deployment_id', 'id'], {
    name: 'idx_dep_events_deployment',
  });

  // --- the two deferred forward references --------------------------------
  pgm.addConstraint('workers', 'workers_current_deployment_fkey', {
    foreignKeys: {
      columns: 'current_deployment_id',
      references: 'deployments(id)',
      onDelete: 'SET NULL',
    },
  });
  pgm.addConstraint('projects', 'projects_active_deployment_fkey', {
    foreignKeys: {
      columns: 'active_deployment_id',
      references: 'deployments(id)',
      onDelete: 'SET NULL',
    },
  });
  pgm.addConstraint('files', 'files_deployment_fkey', {
    foreignKeys: {
      columns: 'deployment_id',
      references: 'deployments(id)',
      onDelete: 'CASCADE',
    },
  });

  pgm.createTrigger('deployments', 'trg_deployments_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger('deployments', 'trg_deployments_set_updated_at', { ifExists: true });
  pgm.dropConstraint('files', 'files_deployment_fkey', { ifExists: true });
  pgm.dropConstraint('projects', 'projects_active_deployment_fkey', { ifExists: true });
  pgm.dropConstraint('workers', 'workers_current_deployment_fkey', { ifExists: true });
  pgm.dropTable('deployment_events', { ifExists: true });
  pgm.dropTable('deployments', { ifExists: true });
  pgm.dropTable('workers', { ifExists: true });
  pgm.dropType('log_stream', { ifExists: true });
  pgm.dropType('worker_status', { ifExists: true });
  pgm.dropType('deployment_status', { ifExists: true });
}
