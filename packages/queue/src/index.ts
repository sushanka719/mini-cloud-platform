export { createRedis, connectRedis, closeRedis, type RedisRole } from './connection.js';
export { configureQueue, QueueTimeoutError, type QueueConfig } from './runtime.js';
export {
  getDeploymentsQueue,
  enqueueDeployment,
  forgetDeploymentJob,
  getDeploymentJobState,
  getQueueStats,
  createDeploymentWorker,
  createDeploymentQueueEvents,
  type DeploymentWorkerOptions,
} from './deployments-queue.js';
export {
  getContainerActionsQueue,
  enqueueContainerAction,
  getContainerActionQueueStats,
  createContainerActionWorker,
  type ContainerActionWorkerOptions,
} from './container-actions-queue.js';
export {
  getDeadLetterQueue,
  enqueueDeadLetter,
  listDeadLetters,
  discardDeadLetter,
  getDeadLetterStats,
} from './dead-letter-queue.js';
export { closeQueue } from './close.js';
export type { Job, Worker as BullWorker, Queue as BullQueue } from 'bullmq';
/**
 * Re-exported so the worker can end a job's retries without importing BullMQ
 * directly: throwing this from a processor tells BullMQ the failure is final,
 * which is how a non-retryable `StageError` skips its remaining attempts
 * (CLAUDE.md §11 — queue definitions live only in this package).
 */
export { UnrecoverableError } from 'bullmq';
