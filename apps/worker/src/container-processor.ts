import { deploymentRepo, getDb, type DeploymentRow, type ProjectRow } from '@forge/db';
import type { Logger } from '@forge/config';
import { env } from '@forge/config';
import { containerActionJobSchema, type ContainerActionJob } from '@forge/shared';
import type { Job } from '@forge/queue';
import { inspectContainer, restartContainer, stopAndRemoveContainer } from './docker/container.js';
import { waitForHealthy } from './docker/health-check.js';
import { logLine, transition } from './services/deployment-state.js';
import { forgetContainerStats } from './services/container-stats.js';
import { ProjectLock } from './services/project-lock.js';

/**
 * The `container-actions` consumer: stop and restart, executed against Docker.
 *
 * Both take the project lock, for the same reason the deploy pipeline does: a
 * stop racing a deployment of the same project must not remove the container
 * the deployment just published, and a restart racing one must not health-check
 * a container that is about to be replaced.
 *
 * Both also write into `deployment_events` and publish, so the action shows up
 * in the dashboard's timeline for that deployment rather than happening
 * invisibly (CLAUDE.md §9.6).
 */
export function createContainerActionProcessor(log: Logger) {
  return async function processContainerAction(job: Job<ContainerActionJob>): Promise<void> {
    const payload = containerActionJobSchema.parse(job.data);
    const actionLog = log.child({
      deploymentId: payload.deploymentId,
      action: payload.action,
      jobId: job.id,
    });

    const row = await deploymentRepo.findDeploymentById(payload.deploymentId);
    if (!row) {
      actionLog.warn('deployment row is gone; dropping the action');
      return;
    }

    const project = await getDb()
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', row.project_id)
      .executeTakeFirst();
    if (!project) {
      actionLog.warn('project is gone; dropping the action');
      return;
    }

    const lock = await ProjectLock.acquire(project.id, {
      ttlMs: env.DOCKER_LOCK_TTL_MS,
      waitMs: env.DOCKER_LOCK_WAIT_MS,
      log: actionLog,
    });
    if (!lock) {
      await logLine(
        row,
        'system',
        `Could not ${payload.action} the container: a deployment of this project holds its lock`,
      );
      throw new Error(
        `Could not ${payload.action}: the project lock was held for more than ${String(env.DOCKER_LOCK_WAIT_MS)}ms`,
      );
    }

    try {
      // Re-read under the lock: the row may have moved since the job was
      // enqueued (a new deployment went live, someone else stopped it).
      const current = (await deploymentRepo.findDeploymentById(row.id)) ?? row;
      if (payload.action === 'stop') {
        await stopDeployment(current, project, actionLog);
      } else {
        await restartDeployment(current, project, actionLog);
      }
    } finally {
      await lock.release();
    }
  };
}

/**
 * Stops a deployment: remove the container, settle the row as `stopped`.
 *
 * Removing rather than merely stopping (ROADMAP Phase 7: "remove container on
 * stop") — a stopped-but-present container still holds its name and its
 * published port, and it would make the orphan sweep's "should this be running?"
 * test ambiguous. The image is kept, which is what makes Phase 8's "start it
 * again from the stored image" possible.
 */
async function stopDeployment(
  row: DeploymentRow,
  project: ProjectRow,
  log: Logger,
): Promise<void> {
  if (row.container_id) {
    const removed = await stopAndRemoveContainer(row.container_id, log);
    await logLine(
      row,
      'system',
      removed
        ? `Container ${row.container_id.slice(0, 12)} stopped and removed`
        : `Container ${row.container_id.slice(0, 12)} could not be removed; it may already be gone`,
    );
    await forgetContainerStats(row.id);
  } else {
    await logLine(row, 'system', 'This deployment has no container to stop');
  }

  // The pointer is cleared conditionally: a deploy that went live while this
  // job waited must keep its claim on the project.
  const cleared = await deploymentRepo.clearActiveDeploymentIf(project.id, row.id);
  if (cleared) {
    await logLine(row, 'system', `${project.name} no longer has an active deployment`);
  }

  if (row.status === 'live') {
    await transition(row, 'stopped', {
      message: 'Stopped by request',
      patch: { finished_at: new Date(), host_port: null, url: null },
    });
  } else {
    // Already terminal: the container is gone either way, and forcing a second
    // `stopped` write would append a transition that never happened.
    log.info({ status: row.status }, 'deployment was not live; only the container was removed');
  }
}

/**
 * Restarts a deployment's container in place and re-checks its health.
 *
 * In place, so the container *id* survives — but not, it turns out, the URL.
 * The port is published with an empty `HostPort`, which means Docker picks a
 * free one, and it picks a **new** one on every start: a restart moves the app
 * from `:32772` to `:32773`. That is a real property of ephemeral publishing,
 * not a bug to hide, so the new binding is read back and persisted, and the
 * `live` row is re-recorded with it (`force`, because `live → live` is not a
 * transition the state machine has — the deployment never stopped being live).
 * Re-recording it is also what puts the restart in the dashboard's timeline
 * and tells it to re-read the row. A URL stable across restarts needs a proxy
 * in front, which is Phase 12's `*.localhost` routing.
 */
async function restartDeployment(
  row: DeploymentRow,
  project: ProjectRow,
  log: Logger,
): Promise<void> {
  if (!row.container_id) {
    await logLine(row, 'system', 'This deployment has no container to restart');
    throw new Error('This deployment has no container to restart');
  }
  if (row.status !== 'live') {
    await logLine(
      row,
      'system',
      `Cannot restart a deployment that is "${row.status}"; deploy again instead`,
    );
    throw new Error(`Cannot restart a deployment that is "${row.status}"`);
  }

  await logLine(row, 'system', `$ docker restart ${row.container_id.slice(0, 12)}`);
  await restartContainer(row.container_id);

  const state = await inspectContainer(row.container_id, project.app_port);
  const hostPort = state?.hostPort ?? null;
  if (!state || hostPort === null) {
    await failAfterRestart(row, 'RESTART_FAILED', 'The container did not come back after a restart', log);
    return;
  }

  const url = `http://localhost:${String(hostPort)}`;
  await logLine(
    row,
    'system',
    hostPort === row.host_port
      ? `Container restarted; re-running the health check against ${url}`
      : `Container restarted and Docker published it on a new port; re-running the health check against ${url} (was ${row.url ?? 'none'})`,
  );

  const health = await waitForHealthy({
    hostPort,
    healthPath: project.health_path,
    timeoutMs: project.health_timeout_ms,
    log,
    // Nothing to abort against here: a restart is seconds, not minutes, and the
    // worker's shutdown timeout is longer than the health budget.
    signal: new AbortController().signal,
    precondition: async () => {
      const current = await inspectContainer(row.container_id ?? '', project.app_port);
      if (!current) return 'the container no longer exists';
      if (!current.running) {
        return `the container exited with code ${String(current.exitCode ?? -1)}`;
      }
      return null;
    },
    onAttempt: async (attempt, probe) => {
      await logLine(
        row,
        'system',
        `Health check attempt ${String(attempt)}: ` +
          (probe.ok ? `${String(probe.statusCode)} OK` : (probe.error ?? 'no response')),
      );
    },
  });

  if (!health.ok) {
    await failAfterRestart(
      row,
      'HEALTH_CHECK_FAILED',
      `${project.health_path} did not answer 2xx within ${String(project.health_timeout_ms)}ms after the restart: ${health.lastError ?? 'no response'}`,
      log,
    );
    return;
  }

  // Re-record `live` with whatever port the restart landed on. `force` because
  // the deployment never left `live`; the event is what makes the restart
  // visible in the timeline and what tells the dashboard to re-read the row.
  await transition(row, 'live', {
    force: true,
    message: `Restarted and healthy again at ${url}`,
    patch: { host_port: hostPort, url },
  });
  await logLine(
    row,
    'system',
    `Restart complete: healthy again at ${url} after ${String(health.attempts)} attempts in ${String(health.durationMs)}ms`,
  );
}

/**
 * A restart that did not come back healthy leaves nothing serving, so the
 * container is removed and the deployment is recorded as failed — the same
 * outcome a failed deployment gets, because it is the same situation.
 */
async function failAfterRestart(
  row: DeploymentRow,
  code: string,
  message: string,
  log: Logger,
): Promise<void> {
  if (row.container_id) {
    await stopAndRemoveContainer(row.container_id, log);
    await forgetContainerStats(row.id);
  }
  await deploymentRepo.clearActiveDeploymentIf(row.project_id, row.id);
  await transition(row, 'failed', {
    force: true,
    message: `${code}: ${message}`,
    patch: {
      error_code: code,
      error_message: message,
      finished_at: new Date(),
      host_port: null,
      url: null,
    },
  });
  log.warn({ deploymentId: row.id, code }, 'restart failed; container removed');
  throw new Error(message);
}
