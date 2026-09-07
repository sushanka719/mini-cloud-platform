/**
 * Prefix @fastify/rate-limit prepends to every counter (including the
 * per-route buckets it derives itself), so all of them stay under `rl:`.
 */
export const RATE_LIMIT_NAMESPACE = 'rl:';

/** The identity half of a rate-limit key; the namespace is added by the store. */
export const rateLimitIdentity = (scope: string, id: string) => `${scope}:${id}`;

/** Redis key namespaces — keep every key construction in one place. */
export const REDIS_KEYS = {
  /** `tokenHash` is sha256(rawToken); raw session tokens never enter Redis. */
  session: (tokenHash: string) => `session:${tokenHash}`,
  /** Set of a user's live session hashes, so "log out everywhere" is one pass. */
  userSessions: (userId: string) => `user:${userId}:sessions`,
  /** Composed rate-limit key. @fastify/rate-limit builds the same shape from
   *  RATE_LIMIT_NAMESPACE + rateLimitIdentity(). */
  rateLimit: (scope: string, id: string) => `${RATE_LIMIT_NAMESPACE}${scope}:${id}`,
  projectLock: (projectId: string) => `lock:project:${projectId}`,
  workerHeartbeat: (workerId: string) => `worker:${workerId}:heartbeat`,
  /** Set of worker ids that have ever registered; heartbeat TTL decides liveness. */
  workersOnline: 'workers:online',
  deploymentLogTail: (deploymentId: string) => `deployment:${deploymentId}:logtail`,
  /**
   * Latest sampled stats for one running container. Ephemeral by nature — a
   * sample is worthless a minute later — so it lives here under a TTL rather
   * than accumulating rows in Postgres.
   */
  containerStats: (deploymentId: string) => `container:${deploymentId}:stats`,
  /**
   * Held by whichever worker is currently sampling container stats. Without it
   * every replica would poll the Docker API for every live container on every
   * tick, N times over, for one document.
   */
  containerMonitorLock: 'lock:container-monitor',
  /**
   * One process's latest metrics document (Phase 9).
   *
   * Redis under a TTL for the same reason container samples are: a CPU reading
   * is worthless a minute later, and expiry is exactly the right rule for
   * "this process stopped reporting". It is also what lets *any* API replica
   * render the whole fleet's process metrics — the numbers are shared state,
   * not process memory (CLAUDE.md §4).
   */
  processMetrics: (role: string, instance: string) => `metrics:process:${role}:${instance}`,
  /**
   * Set of `<role>:<instance>` ids that have ever reported. The document's TTL
   * decides liveness; an id whose document is gone is pruned from here by the
   * reader, exactly like `workersOnline`.
   */
  metricsProcesses: 'metrics:processes',
  /**
   * Held by whichever process publishes queue depth on the `metrics` topic
   * this tick. Without it N API replicas would each publish the same three
   * queue counters, and the dashboard would chart N× the real depth.
   */
  queueMetricsLock: 'lock:queue-metrics',
  /**
   * Held by whichever worker is sweeping abandoned deployments this tick
   * (Phase 10). Same shape as the two leases above: N workers all reaping the
   * same rows would each write the same failure event, and the timeline would
   * say a deployment was lost N times.
   */
  orphanReaperLock: 'lock:orphan-reaper',
} as const;

/** Redis Pub/Sub channels. */
export const REDIS_CHANNELS = {
  deployment: (deploymentId: string) => `deployment:${deploymentId}`,
  project: (projectId: string) => `project:${projectId}`,
  org: (orgId: string) => `org:${orgId}`,
  metrics: 'metrics',
} as const;

export const QUEUE_NAMES = {
  deployments: 'deployments',
  /**
   * Where a deployment's job lands once its retry budget is spent (Phase 8).
   *
   * Nothing consumes it: it is a durable parking lot, not a pipeline. A queue
   * rather than a table because the *job* is what we want to keep — its
   * payload, its attempt count, its failure reason — and BullMQ already stores
   * all three with a bounded retention.
   */
  deploymentsDlq: 'deployments-dlq',
  /**
   * Stop/restart requests for a running container. Separate from
   * `deployments` on purpose: the API cannot call Docker itself, and a stop
   * must not queue behind a five-minute build.
   */
  containerActions: 'container-actions',
} as const;

/** BullMQ job name inside the `deployments` queue. */
export const DEPLOYMENT_JOB_NAME = 'deploy';

/** BullMQ job name inside the `container-actions` queue. */
export const CONTAINER_ACTION_JOB_NAME = 'container-action';

/** BullMQ job name inside the `deployments-dlq` queue. */
export const DEAD_LETTER_JOB_NAME = 'dead-letter';

/**
 * How long a worker's Redis heartbeat key lives past its last write. Three
 * intervals: one missed beat is a hiccup, three is a dead process.
 */
export const WORKER_HEARTBEAT_TTL_FACTOR = 3;

/** Prefix of every issued API key; the rest is random. Matched on auth. */
export const API_KEY_PREFIX = 'fc_live_';
/** How much of the key we keep in plaintext for display/lookup (`fc_live_ab12cd34`). */
export const API_KEY_LOOKUP_LENGTH = API_KEY_PREFIX.length + 8;
