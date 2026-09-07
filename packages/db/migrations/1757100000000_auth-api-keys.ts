import type { MigrationBuilder } from 'node-pg-migrate';

export const shorthands: undefined = undefined;

/**
 * Phase 1. Sessions live in Redis (see DATA_MODEL §4), so the only durable auth
 * table we need is `api_keys` for programmatic access.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('api_keys', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'organizations(id)', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    // Non-secret leading slice of the key (`fc_live_ab12cd34`). Shown in the UI
    // and used to find the single candidate row before comparing hashes.
    prefix: { type: 'text', notNull: true },
    // sha256 of the full key. Keys are 256 bits of entropy, so a fast hash is
    // right here — unlike passwords, they aren't guessable, and auth happens
    // on every request (argon2 per request would be a self-inflicted DoS).
    key_hash: { type: 'text', notNull: true },
    // The role this key acts with inside its org, so RBAC is one comparison
    // regardless of whether the caller is a human session or a key.
    role: { type: 'org_role', notNull: true, default: 'member' },
    // Reserved for finer-grained scoping later; unused in Phase 1.
    scopes: { type: 'text[]', notNull: true, default: pgm.func("'{}'::text[]") },
    last_used_at: { type: 'timestamptz' },
    created_by: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'RESTRICT' },
    revoked_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Prefix is the auth lookup path, so it must be unique and indexed.
  pgm.addConstraint('api_keys', 'api_keys_prefix_key', { unique: ['prefix'] });
  pgm.createIndex('api_keys', ['org_id', 'created_at']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('api_keys', { ifExists: true });
}
