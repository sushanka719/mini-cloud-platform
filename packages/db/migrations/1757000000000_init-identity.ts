import type { MigrationBuilder } from 'node-pg-migrate';

export const shorthands: undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createExtension('pgcrypto', { ifNotExists: true }); // gen_random_uuid()
  pgm.createExtension('citext', { ifNotExists: true }); // case-insensitive email

  // Keeps updated_at honest regardless of which process wrote the row.
  pgm.createFunction(
    'set_updated_at',
    [],
    { returns: 'trigger', language: 'plpgsql', replace: true },
    `
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    `,
  );

  pgm.createType('org_role', ['owner', 'admin', 'member', 'viewer']);

  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    email: { type: 'citext', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    password_hash: { type: 'text', notNull: true },
    email_verified_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('organizations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    slug: { type: 'text', notNull: true, unique: true },
    created_by: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'RESTRICT',
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('organizations', 'created_by');

  pgm.createTable('org_members', {
    org_id: {
      type: 'uuid',
      notNull: true,
      references: 'organizations(id)',
      onDelete: 'CASCADE',
    },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    role: { type: 'org_role', notNull: true, default: 'member' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('org_members', 'org_members_pkey', { primaryKey: ['org_id', 'user_id'] });
  pgm.createIndex('org_members', 'user_id');

  for (const table of ['users', 'organizations', 'org_members']) {
    pgm.createTrigger(table, `trg_${table}_set_updated_at`, {
      when: 'BEFORE',
      operation: 'UPDATE',
      level: 'ROW',
      function: 'set_updated_at',
    });
  }
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  for (const table of ['org_members', 'organizations', 'users']) {
    pgm.dropTrigger(table, `trg_${table}_set_updated_at`, { ifExists: true });
  }
  pgm.dropTable('org_members', { ifExists: true });
  pgm.dropTable('organizations', { ifExists: true });
  pgm.dropTable('users', { ifExists: true });
  pgm.dropType('org_role', { ifExists: true });
  pgm.dropFunction('set_updated_at', [], { ifExists: true });
  // extensions are left in place — other schemas may rely on them
}
