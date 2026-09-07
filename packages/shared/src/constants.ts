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
  deploymentsDlq: 'deployments-dlq',
} as const;

/** BullMQ job name inside the `deployments` queue. */
export const DEPLOYMENT_JOB_NAME = 'deploy';

/**
 * How long a worker's Redis heartbeat key lives past its last write. Three
 * intervals: one missed beat is a hiccup, three is a dead process.
 */
export const WORKER_HEARTBEAT_TTL_FACTOR = 3;

/** Prefix of every issued API key; the rest is random. Matched on auth. */
export const API_KEY_PREFIX = 'fc_live_';
/** How much of the key we keep in plaintext for display/lookup (`fc_live_ab12cd34`). */
export const API_KEY_LOOKUP_LENGTH = API_KEY_PREFIX.length + 8;
