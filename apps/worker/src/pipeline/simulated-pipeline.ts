import { setTimeout as delay } from 'node:timers/promises';
import { env, type Logger } from '@forge/config';
import type { DeploymentRow, ProjectRow } from '@forge/db';
import { DEPLOYMENT_STATUS_LABELS, type DeploymentStatus } from '@forge/shared';
import { logLine, transition } from '../services/deployment-state.js';

/**
 * Phase 4's pipeline: the *real* state machine, persistence, publishing and
 * failure handling, with the work itself stubbed out.
 *
 * Everything here except `delay()` is production code — Phase 6 replaces the
 * `installing`/`building` stages with `child_process.spawn`, and Phase 7
 * replaces the container stages with `dockerode`. The stage list, the order,
 * the transitions and the events they write do not change.
 */

export class StageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StageError';
  }
}

type Stage = {
  status: Exclude<DeploymentStatus, 'queued' | 'assigned'>;
  /** One `system` log line explaining what this stage will really do. */
  describe: (project: ProjectRow, deployment: DeploymentRow) => string;
};

const STAGES: readonly Stage[] = [
  {
    status: 'cloning',
    describe: (project, deployment) =>
      deployment.source_file_id
        ? `Copying source ${deployment.source_file_id} into the build sandbox (rootDir: ${project.root_dir})`
        : `Fetching ${project.repo_url ?? 'source'} @ ${deployment.source_ref ?? 'HEAD'}`,
  },
  {
    status: 'installing',
    describe: (project) => `$ ${project.install_command}`,
  },
  {
    status: 'building',
    describe: (project) => `$ ${project.build_command}`,
  },
  {
    status: 'creating_container',
    describe: (project) =>
      `Creating container: non-root, memory + CPU + pids limits, exposing ${project.app_port}`,
  },
  {
    status: 'starting',
    describe: (project) => `$ ${project.start_command}`,
  },
  {
    status: 'health_check',
    describe: (project) =>
      `GET ${project.health_path} until 2xx (timeout ${project.health_timeout_ms}ms)`,
  },
];

export async function runSimulatedPipeline(
  deployment: DeploymentRow,
  project: ProjectRow,
  log: Logger,
): Promise<DeploymentRow> {
  let row = deployment;

  for (const stage of STAGES) {
    // The status event carries the label (that's what the pipeline animation
    // renders); the detail goes to the log stream, where Phase 6 will send the
    // real stdout/stderr.
    row = await transition(row, stage.status, {
      message: DEPLOYMENT_STATUS_LABELS[stage.status],
    });
    await logLine(row, 'system', stage.describe(project, row));
    log.info({ deploymentId: row.id, status: stage.status }, 'stage');

    // The demo hook: fail exactly where the caller asked, *after* entering the
    // stage, so the timeline shows how far it got.
    if (row.fail_at === stage.status) {
      throw new StageError(
        `${stage.status.toUpperCase()}_FAILED`,
        `Simulated failure during ${stage.status}`,
      );
    }

    if (env.DEPLOY_STAGE_DELAY_MS > 0) await delay(env.DEPLOY_STAGE_DELAY_MS);
  }

  const startedAt = row.started_at ? new Date(row.started_at as unknown as string).getTime() : null;
  const finishedAt = new Date();

  row = await transition(row, 'live', {
    message: 'Deployment is live',
    patch: {
      finished_at: finishedAt,
      duration_ms: startedAt ? finishedAt.getTime() - startedAt : null,
      // No container_id / url / host_port: nothing is actually serving yet.
      // Phase 7 fills these in when dockerode really starts the app.
    },
  });
  await logLine(
    row,
    'system',
    'Simulated pipeline complete — no container is running yet (Phase 7 adds Docker)',
  );

  return row;
}
