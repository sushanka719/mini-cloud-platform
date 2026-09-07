import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { loadDotenv } from './load-dotenv.js';

const dotenvPath = loadDotenv();

/**
 * Apps boot from their own package dir, so a relative STORAGE_ROOT would mean a
 * different directory for the API than for the worker. Anchor it to the repo
 * root (where .env lives) so every process agrees on one object store.
 */
const repoRoot = dotenvPath ? dirname(dotenvPath) : process.cwd();

const csv = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** AES-256 needs exactly 32 bytes; reject a short/typo'd key at boot, not at first write. */
const base64Key = z.string().refine(
  (value) => {
    try {
      return Buffer.from(value, 'base64').length === 32;
    } catch {
      return false;
    }
  },
  { message: 'must be 32 bytes encoded as base64 (generate: openssl rand -base64 32)' },
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  // Identifies this API process in WebSocket `hello` frames, so the dashboard
  // can show which replica served a socket. Defaults to "<hostname>-<pid>",
  // the same convention WORKER_NAME uses.
  API_INSTANCE_ID: z.string().min(1).optional(),
  CORS_ORIGIN: z.string().default('http://localhost:3000').transform(csv),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  REDIS_URL: z.string().url(),

  // --- Auth ---------------------------------------------------------------
  // Opaque session lifetime; the cookie and the Redis key share this TTL.
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),
  // Name of the session cookie the dashboard receives.
  SESSION_COOKIE_NAME: z.string().min(1).default('forge_session'),
  // Send the cookie only over HTTPS. Off by default so local http works.
  SESSION_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // --- Secrets --------------------------------------------------------------
  // 32-byte AES-256-GCM key, base64. Encrypts project env vars at rest.
  // Generate: openssl rand -base64 32
  ENCRYPTION_KEY: base64Key,

  // --- Local object storage -------------------------------------------------
  // Root of the local "object store"; every path is resolved against it and
  // anything escaping is rejected (CLAUDE.md §8).
  STORAGE_ROOT: z
    .string()
    .min(1)
    .default('./storage')
    .transform((value) => (isAbsolute(value) ? value : resolve(repoRoot, value))),
  // Hard cap on an uploaded source archive.
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  // zlib level for artifact compression: 1 = fastest, 9 = smallest.
  GZIP_LEVEL: z.coerce.number().int().min(1).max(9).default(6),
  // Threads in the compression worker pool. Kept small so gzip cannot starve
  // the event loop's core; threads are spawned lazily on first use.
  COMPRESSION_THREADS: z.coerce.number().int().min(1).max(16).default(2),

  // --- Queue & worker -------------------------------------------------------
  // Display name for this worker process in the registry. Defaults to
  // "<hostname>-<pid>" so two workers on one laptop stay distinguishable.
  WORKER_NAME: z.string().min(1).optional(),
  // Deployments this worker process runs at once.
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  // How often a worker writes its heartbeat (Redis TTL key + registry row).
  WORKER_HEARTBEAT_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
  // BullMQ attempts per deployment job. 1 = no retry; Phase 8 raises it and
  // adds the dead-letter hop.
  DEPLOY_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(1),
  // Base delay for the exponential backoff between attempts.
  DEPLOY_JOB_BACKOFF_MS: z.coerce.number().int().min(100).default(5_000),
  // How long BullMQ waits for a job to renew its lock before calling it
  // stalled and handing it to another worker.
  DEPLOY_JOB_LOCK_MS: z.coerce.number().int().min(5_000).default(60_000),
  // Deadline for a single producer-side queue command. BullMQ connections
  // never give up on their own, so this is what turns "Redis is down" into a
  // 503 instead of a hung request.
  QUEUE_OPERATION_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  // Pause between the simulated pipeline's stages (Phase 4 has no real build).
  DEPLOY_STAGE_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(700),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Nothing can run without valid config, and the logger itself needs it — so
    // this is the one place we write to stderr directly and exit.
    process.stderr.write(`\nInvalid environment configuration:\n${issues}\n\nSee .env.example.\n\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const env: Env = parseEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';
