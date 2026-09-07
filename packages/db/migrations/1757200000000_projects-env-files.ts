import type { MigrationBuilder } from 'node-pg-migrate';

export const shorthands: undefined = undefined;

/**
 * Phase 2. Projects, their env vars, and the index of the local object store.
 *
 * Two forward references are deliberately left unconstrained until the
 * deployments table exists (Phase 4):
 *  - `projects.active_deployment_id` — column now, FK added with deployments.
 *  - `files.deployment_id`           — same; artifacts/logs attach in Phase 3/6.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('file_kind', ['source', 'artifact', 'log']);

  pgm.createTable('projects', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'organizations(id)', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    slug: { type: 'text', notNull: true },
    source_type: { type: 'text', notNull: true, default: 'upload' },
    repo_url: { type: 'text' },
    root_dir: { type: 'text', notNull: true, default: '.' },
    install_command: { type: 'text', notNull: true, default: 'npm install' },
    build_command: { type: 'text', notNull: true, default: 'npm run build' },
    start_command: { type: 'text', notNull: true, default: 'npm start' },
    app_port: { type: 'integer', notNull: true, default: 3000 },
    health_path: { type: 'text', notNull: true, default: '/' },
    health_timeout_ms: { type: 'integer', notNull: true, default: 30000 },
    // FK added in the deployments migration (circular reference).
    active_deployment_id: { type: 'uuid' },
    created_by: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'RESTRICT' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('projects', 'projects_org_id_slug_key', { unique: ['org_id', 'slug'] });
  pgm.addConstraint('projects', 'projects_source_type_check', {
    check: "source_type IN ('upload', 'git')",
  });
  pgm.addConstraint('projects', 'projects_app_port_check', {
    check: 'app_port BETWEEN 1 AND 65535',
  });
  pgm.createIndex('projects', ['org_id', 'created_at']);

  pgm.createTable('project_env_vars', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'projects(id)', onDelete: 'CASCADE' },
    key: { type: 'text', notNull: true },
    // AES-256-GCM ciphertext (version byte || iv || tag || payload). Encrypted
    // even when is_secret is false, so one code path handles both.
    value_enc: { type: 'bytea', notNull: true },
    // Plaintext length, kept so the UI can show "•••• (12)" without decrypting.
    value_length: { type: 'integer', notNull: true, default: 0 },
    is_secret: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('project_env_vars', 'project_env_vars_project_id_key_key', {
    unique: ['project_id', 'key'],
  });

  pgm.createTable('files', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', references: 'projects(id)', onDelete: 'CASCADE' },
    // FK added in the deployments migration.
    deployment_id: { type: 'uuid' },
    kind: { type: 'file_kind', notNull: true },
    storage_path: { type: 'text', notNull: true },
    size_bytes: { type: 'bigint', notNull: true, default: 0 },
    checksum: { type: 'text' },
    content_type: { type: 'text' },
    // The client-supplied filename, kept for display only — never used to
    // build a path on disk (CLAUDE.md §8).
    original_name: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('files', ['project_id', 'kind', 'created_at']);
  pgm.createIndex('files', 'deployment_id');

  for (const table of ['projects', 'project_env_vars']) {
    pgm.createTrigger(table, `trg_${table}_set_updated_at`, {
      when: 'BEFORE',
      operation: 'UPDATE',
      level: 'ROW',
      function: 'set_updated_at',
    });
  }
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  for (const table of ['project_env_vars', 'projects']) {
    pgm.dropTrigger(table, `trg_${table}_set_updated_at`, { ifExists: true });
  }
  pgm.dropTable('files', { ifExists: true });
  pgm.dropTable('project_env_vars', { ifExists: true });
  pgm.dropTable('projects', { ifExists: true });
  pgm.dropType('file_kind', { ifExists: true });
}
