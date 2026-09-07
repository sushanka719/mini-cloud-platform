import { deploymentRepo } from '@forge/db';
import type { Logger } from '@forge/config';
import { listManagedContainers, stopAndRemoveContainer } from './container.js';

/**
 * Removing containers nothing owns any more.
 *
 * The same problem `pruneStaleSandboxes` solves, one layer out. A worker
 * SIGKILLed mid-deployment never runs its cleanup, so a container it created
 * keeps running — holding a published port, eating memory, and serving an app
 * the database says is `failed`. Left alone these accumulate every crash.
 *
 * Postgres decides, not age: a container is ours to remove when the deployment
 * it is labelled with is *not* one that should be running. That is a much
 * sharper test than a timestamp, and it is safe with several workers because
 * `listRunningDeployments()` includes the in-progress container stages — so a
 * container another worker created ninety seconds ago and is still
 * health-checking is protected by its row, not by luck.
 */
export type SweepResult = {
  inspected: number;
  removed: number;
  kept: number;
};

export async function sweepOrphanContainers(log: Logger): Promise<SweepResult> {
  const result: SweepResult = { inspected: 0, removed: 0, kept: 0 };

  const containers = await listManagedContainers();
  result.inspected = containers.length;
  if (containers.length === 0) return result;

  const running = await deploymentRepo.listRunningDeployments();
  // Keyed by container id as well as deployment id: a retry reuses the
  // deployment id, so "this deployment should be running" does not by itself
  // license *this particular* container.
  const expected = new Map(running.map((row) => [row.container_id ?? '', row.id]));

  for (const container of containers) {
    const claimedBy = expected.get(container.id);
    if (claimedBy !== undefined && claimedBy === container.deploymentId) {
      result.kept += 1;
      continue;
    }

    const reason =
      container.deploymentId === null
        ? 'container carries no deployment label'
        : claimedBy === undefined
          ? 'no running deployment points at this container'
          : 'the deployment points at a different container';

    // No grace: this container is serving traffic nobody is tracking, and the
    // boot path must not stall on one that ignores SIGTERM.
    if (await stopAndRemoveContainer(container.id, log, { graceSeconds: 0 })) {
      result.removed += 1;
      log.info(
        { containerId: container.id.slice(0, 12), name: container.name, reason },
        'removed orphaned deployment container',
      );
    }
  }

  return result;
}
