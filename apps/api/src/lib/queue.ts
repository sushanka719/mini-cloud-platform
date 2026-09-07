import { env } from '@forge/config';
import { configureQueue } from '@forge/queue';

/**
 * The one place the API injects config into `@forge/queue`. Called once at
 * boot, before any route can enqueue: `getDeploymentsQueue()` throws rather
 * than silently connecting to a default if this is skipped.
 */
export function configureQueueFromEnv(): void {
  configureQueue({
    redisUrl: env.REDIS_URL,
    attempts: env.DEPLOY_JOB_ATTEMPTS,
    backoffMs: env.DEPLOY_JOB_BACKOFF_MS,
    operationTimeoutMs: env.QUEUE_OPERATION_TIMEOUT_MS,
  });
}
