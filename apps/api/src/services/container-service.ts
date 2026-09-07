import {
  REDIS_KEYS,
  conflict,
  containerStatsSchema,
  serviceUnavailable,
  type ContainerAction,
  type ContainerActionResult,
  type ContainerStats,
  type ContainerSummary,
} from '@forge/shared';
import { deploymentRepo, type RunningDeploymentRow } from '@forge/db';
import { enqueueContainerAction } from '@forge/queue';
import { getRedis } from '../lib/redis.js';
import { requireDeployment } from './deployment-service.js';

/**
 * Running containers, from the API's side of the wall.
 *
 * The API does not — and must not — talk to Docker (ARCHITECTURE §9). So this
 * reads the two places the truth actually lives: Postgres for *what* is
 * supposed to be running (the deployment row carries `container_id`, `url`,
 * `host_port` and `image_tag`) and Redis for *how* it is doing (the samples a
 * worker's container monitor writes under a TTL).
 *
 * That split has a nice property: the view is identical from any API replica,
 * and it keeps working when the Docker host is behind a different worker
 * entirely — which is the same reason sessions live in Redis.
 */

/**
 * Reads stats samples for many deployments in one round trip.
 *
 * A missing key is a first-class answer, not an error: it means no worker has
 * sampled that container recently (the monitor is disabled, the worker is gone,
 * Redis restarted), and the dashboard shows "—" rather than a stale number.
 *
 * Exported because Phase 9's metrics snapshot needs the same samples for a
 * different set of deployments (org-wide for the dashboard, host-wide for the
 * Prometheus scrape), and two readers of one Redis key shape is one reader too
 * many.
 */
export async function readContainerStats(
  deploymentIds: string[],
): Promise<Map<string, ContainerStats>> {
  const found = new Map<string, ContainerStats>();
  if (deploymentIds.length === 0) return found;

  let values: (string | null)[];
  try {
    values = await getRedis().mget(
      ...deploymentIds.map((id) => REDIS_KEYS.containerStats(id)),
    );
  } catch {
    // Redis down: every container reports "no sample". The list still renders
    // from Postgres, which is the degradation CLAUDE.md §10 asks for.
    return found;
  }

  values.forEach((raw, index) => {
    const id = deploymentIds[index];
    if (raw === null || id === undefined) return;
    try {
      const parsed = containerStatsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) found.set(id, parsed.data);
    } catch {
      // A sample written by an older worker; ignored rather than rendered.
    }
  });
  return found;
}

function toContainerSummary(
  row: RunningDeploymentRow,
  stats: ContainerStats | undefined,
): ContainerSummary {
  const iso = (value: Date | string | null): string | null =>
    value === null ? null : new Date(value as unknown as string).toISOString();

  return {
    deploymentId: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    projectSlug: row.project_slug,
    orgId: row.org_id,
    status: row.status,
    containerId: row.container_id,
    imageTag: row.image_tag,
    url: row.url,
    hostPort: row.host_port,
    appPort: row.app_port,
    healthPath: row.health_path,
    attempt: row.attempt,
    startedAt: iso(row.started_at as unknown as string | null),
    liveSince: row.status === 'live' ? iso(row.finished_at as unknown as string | null) : null,
    isActive: row.active_deployment_id === row.id,
    stats: stats ?? null,
  };
}

/** Every container this org has running, newest first. */
export async function getOrgContainers(orgId: string): Promise<ContainerSummary[]> {
  const rows = await deploymentRepo.listOrgRunningDeployments(orgId);
  const stats = await readContainerStats(rows.map((row) => row.id));
  return rows.map((row) => toContainerSummary(row, stats.get(row.id)));
}

/**
 * Queues a stop or a restart.
 *
 * The API's whole job here is to check that the request makes sense and hand it
 * on — it records nothing itself, because the worker's execution is what
 * produces the transition, and a row saying `stopped` before the container is
 * actually gone would be a lie the dashboard would show.
 *
 * `enqueued: false` is a real outcome, not an error: asking to stop something
 * that is already stopped is a request that has already been satisfied, and a
 * 409 would make a double-click look like a failure.
 */
export async function requestContainerAction(
  projectId: string,
  deploymentId: string,
  action: ContainerAction,
  requestedBy: string | null,
): Promise<ContainerActionResult> {
  const row = await requireDeployment(projectId, deploymentId);

  if (action === 'restart' && row.status !== 'live') {
    throw conflict(
      'NOT_LIVE',
      `Only a live deployment can be restarted; this one is "${row.status}". Deploy again instead.`,
    );
  }
  if (action === 'stop' && row.container_id === null) {
    return {
      action,
      deploymentId: row.id,
      enqueued: false,
      message: 'This deployment has no container running',
    };
  }
  if (action === 'stop' && row.status !== 'live') {
    return {
      action,
      deploymentId: row.id,
      enqueued: false,
      message: `This deployment is already "${row.status}"`,
    };
  }

  try {
    await enqueueContainerAction({
      deploymentId: row.id,
      projectId: row.project_id,
      orgId: row.org_id,
      action,
      requestedBy,
    });
  } catch (err) {
    throw serviceUnavailable(
      'QUEUE_UNAVAILABLE',
      `The queue is unavailable, so the ${action} was not started`,
      err,
    );
  }

  return {
    action,
    deploymentId: row.id,
    enqueued: true,
    message:
      action === 'stop'
        ? 'Stopping: a worker will remove the container'
        : 'Restarting: a worker will bounce the container and re-run the health check',
  };
}
