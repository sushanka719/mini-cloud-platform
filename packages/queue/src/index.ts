export { createRedis, connectRedis, closeRedis, type RedisRole } from './connection.js';
export {
  configureQueue,
  getDeploymentsQueue,
  enqueueDeployment,
  forgetDeploymentJob,
  getQueueStats,
  createDeploymentWorker,
  createDeploymentQueueEvents,
  closeQueue,
  QueueTimeoutError,
  type QueueConfig,
  type DeploymentWorkerOptions,
} from './deployments-queue.js';
export type { Job, Worker as BullWorker, Queue as BullQueue } from 'bullmq';
