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
  // BullMQ attempts per deployment job (Phase 8). A *retryable* failure — a
  // health check that timed out, a build killed by a signal, a project lock
  // held too long — is tried this many times with exponential backoff before
  // the job is parked in `deployments-dlq`. A failure the pipeline knows is
  // not retryable (a build that exited non-zero) skips straight to the DLQ.
  DEPLOY_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  // Base delay for the exponential backoff between attempts: 5s, 10s, 20s…
  DEPLOY_JOB_BACKOFF_MS: z.coerce.number().int().min(100).default(5_000),
  // How many exhausted jobs the dead-letter queue keeps for inspection. It is
  // a parking lot, not a log, so it is bounded.
  DEPLOY_DLQ_KEEP: z.coerce.number().int().min(10).max(10_000).default(1_000),
  // How long BullMQ waits for a job to renew its lock before calling it
  // stalled and handing it to another worker.
  //
  // This is the clock the Phase 10 crash demo runs on: kill a worker mid-build
  // and nothing can happen until its lock lapses. 30s (down from 60s) is short
  // enough to watch and still an eternity next to the renewal interval, which
  // BullMQ runs at half this value on a timer independent of the processor.
  DEPLOY_JOB_LOCK_MS: z.coerce.number().int().min(5_000).default(30_000),
  // How often a worker scans for jobs whose lock has lapsed. The recovery
  // delay is therefore up to DEPLOY_JOB_LOCK_MS + this.
  DEPLOY_JOB_STALL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
  // How many times one job may be recovered from a stall before BullMQ gives
  // up and fails it outright. A stall is not a failed attempt — it burns no
  // retry budget — so this is a separate ceiling, and it exists to stop a job
  // that reliably kills its worker from killing every worker in turn.
  DEPLOY_JOB_MAX_STALLED: z.coerce.number().int().min(1).max(10).default(2),
  // Deadline for a single producer-side queue command. BullMQ connections
  // never give up on their own, so this is what turns "Redis is down" into a
  // 503 instead of a hung request.
  QUEUE_OPERATION_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),

  // --- Build execution (Phase 6) --------------------------------------------
  // Root of the build sandboxes. One directory per deployment; every path the
  // pipeline touches is resolved against it and anything escaping is rejected
  // (CLAUDE.md §8). Anchored to the repo root for the same reason STORAGE_ROOT
  // is: the worker's cwd is its own package dir.
  BUILD_ROOT: z
    .string()
    .min(1)
    .default('./builds')
    .transform((value) => (isAbsolute(value) ? value : resolve(repoRoot, value))),
  // Deadline for the install step. Exceeding it kills the process group.
  BUILD_INSTALL_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(300_000),
  // Deadline for the build step.
  BUILD_BUILD_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(300_000),
  // How long a killed step gets between SIGTERM and SIGKILL.
  BUILD_KILL_GRACE_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  // Total build output we persist/publish per deployment. Past this the log is
  // truncated with a notice rather than filling Postgres with someone's
  // `npm install` (CLAUDE.md §8: limit log output size).
  BUILD_MAX_LOG_BYTES: z.coerce.number().int().min(1_024).default(4 * 1024 * 1024),
  // Cap on `deployment_events` log rows per deployment. The complete log always
  // goes to the stored log object; this only bounds the replayable tail.
  BUILD_MAX_LOG_EVENTS: z.coerce.number().int().min(50).default(5_000),
  // Extraction guards against a hostile archive (zip bomb / file bomb).
  BUILD_MAX_EXTRACT_BYTES: z.coerce.number().int().min(1_024).default(512 * 1024 * 1024),
  BUILD_MAX_EXTRACT_FILES: z.coerce.number().int().min(1).default(50_000),
  // Keep the sandbox on disk after the deployment finishes. Off by default;
  // turn it on to inspect what a failed build actually produced.
  BUILD_KEEP_SANDBOX: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // PATH handed to build processes. The worker's own environment is *not*
  // inherited (it holds DATABASE_URL, REDIS_URL and ENCRYPTION_KEY), so the
  // one thing a build genuinely needs from it is passed explicitly.
  BUILD_PATH: z.string().min(1).optional(),

  // --- Docker deployment (Phase 7) ------------------------------------------
  // Path to the Docker Engine socket. A TCP endpoint can be used instead by
  // setting DOCKER_HOST, which dockerode reads itself.
  DOCKER_SOCKET: z.string().min(1).default('/var/run/docker.sock'),
  // Runtime base image every deployment is built FROM. Must already be present
  // locally unless DOCKER_PULL_BASE_IMAGE is on.
  DOCKER_BASE_IMAGE: z.string().min(1).default('node:22-alpine'),
  // Pull the base image if it is missing. Off by default so a demo without a
  // network fails with a clear message instead of hanging on a registry.
  DOCKER_PULL_BASE_IMAGE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // First path component of every image we build: `forge/<slug>-<id>:<tag>`.
  DOCKER_IMAGE_PREFIX: z.string().min(1).default('forge'),
  // Docker network deployment containers join. A dedicated user-defined bridge
  // (created on demand) rather than the default one, so deployments are not on
  // the same network as our own infrastructure containers. `host` is refused —
  // see CLAUDE.md §8, "no host network by default".
  DOCKER_NETWORK: z.string().min(1).default('forge-deployments'),
  // Host interface published ports bind to. Loopback by default: a deployment
  // is reachable from this machine, not from the LAN.
  DOCKER_HOST_IP: z.string().min(1).default('127.0.0.1'),
  // Hard resource limits per container (CLAUDE.md §8).
  DOCKER_MEMORY_MB: z.coerce.number().int().min(16).default(512),
  DOCKER_CPUS: z.coerce.number().min(0.1).max(64).default(1),
  DOCKER_PIDS_LIMIT: z.coerce.number().int().min(16).default(256),
  // Mount the container's root filesystem read-only, with a tmpfs at /tmp.
  DOCKER_READONLY_ROOTFS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  DOCKER_TMPFS_MB: z.coerce.number().int().min(1).default(64),
  // Deadline for `docker build`. The build runs in the daemon, so exceeding it
  // abandons our stream rather than cancelling the daemon's work.
  DOCKER_BUILD_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(300_000),
  // Deadline for create + start (image load, network attach, port bind).
  DOCKER_START_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  // How often the health check polls. The per-deployment budget is the
  // project's own `health_timeout_ms`.
  DOCKER_HEALTH_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
  // Per-attempt HTTP timeout inside the health check.
  DOCKER_HEALTH_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).default(3_000),
  // Grace period Docker gives a container between SIGTERM and SIGKILL on stop.
  DOCKER_STOP_GRACE_SECONDS: z.coerce.number().int().min(0).max(300).default(10),
  // How much of a container's startup output we follow into the build log.
  DOCKER_MAX_RUNTIME_LOG_LINES: z.coerce.number().int().min(0).default(2_000),
  // Container stats sampling. 0 disables the monitor entirely.
  DOCKER_STATS_INTERVAL_MS: z.coerce.number().int().min(0).default(3_000),
  // How long a sample stays readable in Redis. Longer than the interval, so a
  // single missed tick doesn't blank the dashboard.
  DOCKER_STATS_TTL_SECONDS: z.coerce.number().int().min(1).default(20),
  // Cap on the build context / artifact tarball. A context bigger than this is
  // refused rather than streamed into the daemon.
  DOCKER_MAX_CONTEXT_BYTES: z.coerce.number().int().min(1_024).default(512 * 1024 * 1024),
  // Store the build context as a gzip artifact object per deployment. This is
  // what makes a build reproducible after its sandbox is gone.
  DOCKER_STORE_ARTIFACT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Images kept per project. Older ones are removed after a successful deploy;
  // Phase 8's rollback can only go back as far as this.
  DOCKER_KEEP_IMAGES: z.coerce.number().int().min(1).max(100).default(5),
  // How long to wait for another deployment of the same project to release the
  // `lock:project:<id>` lock before giving up.
  DOCKER_LOCK_WAIT_MS: z.coerce.number().int().min(0).default(30_000),
  // TTL of that lock. Renewed while held, so this only bounds how long a
  // crashed worker can block a project.
  DOCKER_LOCK_TTL_MS: z.coerce.number().int().min(1_000).default(60_000),

  // --- Observability (Phase 9) ----------------------------------------------
  // How often every process samples itself, writes its metrics document to
  // Redis and publishes on the `metrics` topic. 0 disables the reporter
  // entirely (the endpoints still answer, from whatever documents exist).
  METRICS_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(2_000),
  // How long a process's metrics document stays readable. A multiple of the
  // interval, so one missed tick doesn't blank the fleet, but short enough
  // that a killed process drops off the dashboard within seconds.
  METRICS_TTL_SECONDS: z.coerce.number().int().min(1).default(15),
  // Default trailing window for the Postgres deployment aggregates. The
  // dashboard can ask for another; this is what `/metrics` scrapes with.
  METRICS_WINDOW_MINUTES: z.coerce.number().int().min(1).max(60 * 24 * 7).default(60),
  // Bearer token for `GET /metrics`. Optional: without it the endpoint still
  // works, but only for a logged-in user or an API key — a scraper (which
  // carries no session) needs this. Generate: openssl rand -hex 24
  METRICS_TOKEN: z.string().min(16).optional(),
  // Samples of request latency each API process keeps for its percentiles.
  // Bounded because every request writes one.
  METRICS_LATENCY_SAMPLES: z.coerce.number().int().min(16).max(10_000).default(512),

  // --- Local scaling (Phase 10) ---------------------------------------------
  // The reverse proxy in front of the API replicas.
  PROXY_HOST: z.string().min(1).default('0.0.0.0'),
  PROXY_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  // Upstream API replicas, as `host:port`. Empty means "just API_PORT", so a
  // single-process setup can still be run behind the proxy unchanged.
  PROXY_UPSTREAMS: z.string().default('').transform(csv),
  // Path the proxy polls to decide an upstream is usable. `/health/live`
  // deliberately, not `/health`: the proxy asks "is this process answering",
  // and a replica whose Postgres is down is still the right place to send a
  // request that will return a truthful 503. Routing around it would turn one
  // visible outage into a silent one.
  PROXY_HEALTH_PATH: z.string().min(1).default('/health/live'),
  PROXY_HEALTH_INTERVAL_MS: z.coerce.number().int().min(200).default(2_000),
  PROXY_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(100).default(1_500),
  // Consecutive probe results needed to flip an upstream's state. Asymmetric
  // on purpose: drop a replica fast, take it back slowly.
  PROXY_UNHEALTHY_AFTER: z.coerce.number().int().min(1).default(2),
  PROXY_HEALTHY_AFTER: z.coerce.number().int().min(1).default(2),
  // How long the proxy waits for an upstream's response headers before giving
  // up on it. Generous: a source upload streams through this.
  PROXY_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(120_000),
  // Idle timeout on a proxied connection. Must exceed the WebSocket ping
  // interval or live sockets would be culled between frames.
  PROXY_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(120_000),

  // How far back the fleet view looks for workers. A `workers` row per process
  // run is the right *history* — it is how "which worker ran this build" stays
  // answerable — but as a live view it accumulates every process that ever ran
  // on the laptop, so the page shows the ones seen this recently.
  FLEET_WORKER_WINDOW_MINUTES: z.coerce.number().int().min(1).max(60 * 24 * 30).default(120),

  // A deployment sitting in an in-flight status with no live worker behind it
  // is swept after this long. Must stay well clear of the stall window above
  // (lock + stall interval), because BullMQ's recovery is the *good* path and
  // the sweep is only for jobs the queue lost entirely.
  ORPHAN_REAP_AFTER_MS: z.coerce.number().int().min(10_000).default(180_000),
  // How often a worker runs that sweep. 0 disables it.
  ORPHAN_REAP_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
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
