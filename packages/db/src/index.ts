export { getDb, getPool, pingDb, closeDb, type Db } from './client.js';
export * from './types.js';
export * as deploymentRepo from './repositories/deployments.js';
// Re-exported by name as well: the API's serializers take this row type as a
// parameter, and `deploymentRepo.RunningDeploymentRow` in a signature reads as
// if the namespace were the value it is not.
export type {
  RunningDeploymentRow,
  RollbackTargetRow,
  DeploymentWithWorkerRow,
} from './repositories/deployments.js';
export * as metricsRepo from './repositories/metrics.js';
export type { DeploymentStatsOptions } from './repositories/metrics.js';
export * as envVarRepo from './repositories/env-vars.js';
export type { ResolvedEnvVar } from './repositories/env-vars.js';
export * as fileRepo from './repositories/files.js';
export * as workerRepo from './repositories/workers.js';
export { encryptSecret, decryptSecret } from './secret-box.js';
export { sql } from 'kysely';
