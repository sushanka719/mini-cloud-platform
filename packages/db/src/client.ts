import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { env } from '@forge/config';
import type { Database } from './types.js';

// Postgres returns bigint/numeric as strings to avoid precision loss. We want
// int8 (used by append-only event ids) as a JS number — safe below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export type Db = Kysely<Database>;

let pool: pg.Pool | null = null;
let db: Db | null = null;

/** Process-wide singleton pool + Kysely instance. */
export function getDb(): Db {
  if (db) return db;
  pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    // Fail fast instead of hanging a request when Postgres is down (failure demo).
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle-client error (e.g. Postgres restarted) must not crash the process.
  pool.on('error', (err) => {
    process.emitWarning(`postgres pool error: ${err.message}`);
  });
  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return db;
}

export function getPool(): pg.Pool {
  if (!pool) getDb();
  if (!pool) throw new Error('Postgres pool not initialised');
  return pool;
}

/** Round-trips a trivial query; used by /health and startup checks. */
export async function pingDb(): Promise<void> {
  await sql`select 1`.execute(getDb());
}

export async function closeDb(): Promise<void> {
  const current = db;
  db = null;
  pool = null;
  if (current) await current.destroy(); // destroys the underlying pool too
}
