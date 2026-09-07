import { deploymentRepo, type DeploymentEventRow, type DeploymentRow } from '@forge/db';
import { WS_REPLAY_LIMIT, type WsLogFrame, type WsStatusFrame } from '@forge/shared';

/**
 * Reconnect replay (ROADMAP Phase 5): on subscribing to `deployment:<id>` the
 * client may pass the id of the last event it saw, and the gateway sends the
 * `deployment_events` tail past that point before the first live frame.
 *
 * This is why publishing is allowed to be best-effort in the worker: Postgres
 * holds the authoritative timeline, so a frame lost to a dropped socket or a
 * Redis blip is recovered here rather than lost.
 */

/**
 * Rebuilds the published frame from its persisted row.
 *
 * `deployment_events.id` is monotonic, so it doubles as both the cursor and
 * the de-duplication key against live frames arriving during the replay.
 */
export function eventToFrame(
  deployment: DeploymentRow,
  topic: string,
  row: DeploymentEventRow,
): WsStatusFrame | WsLogFrame | null {
  const base = {
    topic,
    deploymentId: deployment.id,
    projectId: deployment.project_id,
    orgId: deployment.org_id,
    eventId: Number(row.id),
    at: new Date(row.created_at as unknown as string).toISOString(),
  };

  if (row.type === 'status') {
    // A status row without a status is not a transition; skip rather than
    // inventing one.
    if (!row.status) return null;
    return { ...base, type: 'status', status: row.status, message: row.message };
  }

  if (!row.stream) return null;
  return {
    ...base,
    type: 'log',
    // Log rows written before Phase 5 didn't record the status they were
    // produced under; fall back to where the deployment ended up.
    status: row.status ?? deployment.status,
    stream: row.stream,
    message: row.message ?? '',
  };
}

export type ReplayResult = {
  frames: (WsStatusFrame | WsLogFrame)[];
  /** Highest event id sent, or null if the tail was empty. */
  through: number | null;
};

export async function loadReplay(
  deployment: DeploymentRow,
  topic: string,
  afterEventId: number,
): Promise<ReplayResult> {
  const rows = await deploymentRepo.listDeploymentEvents(deployment.id, {
    afterId: afterEventId,
    limit: WS_REPLAY_LIMIT,
  });

  const frames: (WsStatusFrame | WsLogFrame)[] = [];
  let through: number | null = null;
  for (const row of rows) {
    const frame = eventToFrame(deployment, topic, row);
    // Advance the cursor even for a row we can't render, or a malformed row
    // would be re-read on every reconnect.
    through = Number(row.id);
    if (frame) frames.push(frame);
  }
  return { frames, through };
}
