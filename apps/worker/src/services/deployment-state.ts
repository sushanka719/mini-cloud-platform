import {
  REDIS_CHANNELS,
  canTransition,
  clampLogLine,
  type DeploymentMessage,
  type DeploymentStatus,
  type LogStream,
} from '@forge/shared';
import { deploymentRepo, type DeploymentRow, type DeploymentUpdate } from '@forge/db';
import type { Logger } from '@forge/config';
import { getPublisher } from '../lib/redis.js';

/**
 * The single place a deployment's status changes.
 *
 * Every transition does three things, in this order (CLAUDE.md §7):
 *   1. update `deployments.status` (+ whatever columns the stage produced),
 *   2. append an immutable row to `deployment_events`,
 *   3. publish it on `deployment:<id>` so the API can fan it out to sockets.
 *
 * Postgres first: the durable record must exist before anyone is told about
 * it. Publishing is best-effort — a dropped frame costs a dashboard update,
 * and Phase 5's reconnect replay reads the timeline back from step 2.
 */

export class InvalidTransitionError extends Error {
  constructor(from: DeploymentStatus, to: DeploymentStatus) {
    super(`Illegal deployment transition ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

async function publish(message: DeploymentMessage): Promise<void> {
  const body = JSON.stringify(message);
  try {
    const redis = getPublisher();
    // Three channels, one per topic the dashboard can watch: the deployment
    // detail view, the project's build list, and the org-wide activity feed.
    await redis.publish(REDIS_CHANNELS.deployment(message.deploymentId), body);
    await redis.publish(REDIS_CHANNELS.project(message.projectId), body);
    await redis.publish(REDIS_CHANNELS.org(message.orgId), body);
  } catch {
    // Deliberately swallowed — see the note above.
  }
}

export type TransitionOptions = {
  message?: string;
  /** Columns the stage produced (container id, url, error, timings…). */
  patch?: DeploymentUpdate;
  /** Skip the state-machine check — only the retry re-queue needs this. */
  force?: boolean;
};

export async function transition(
  row: DeploymentRow,
  to: DeploymentStatus,
  options: TransitionOptions = {},
): Promise<DeploymentRow> {
  if (!options.force && !canTransition(row.status, to)) {
    throw new InvalidTransitionError(row.status, to);
  }

  const updated = await deploymentRepo.updateDeployment(row.id, {
    ...options.patch,
    status: to,
  });
  if (!updated) throw new Error(`deployment ${row.id} vanished mid-pipeline`);

  const event = await deploymentRepo.insertDeploymentEvent({
    deploymentId: row.id,
    type: 'status',
    status: to,
    message: options.message ?? null,
  });

  await publish({
    type: 'status',
    deploymentId: row.id,
    projectId: row.project_id,
    orgId: row.org_id,
    status: to,
    eventId: Number(event.id),
    message: options.message ?? null,
    at: new Date().toISOString(),
  });

  return updated;
}

/**
 * A pipeline log line. Phase 6 pipes real stdout/stderr through here; Phase 4
 * only emits `system` lines so the timeline explains itself.
 */
export async function logLine(
  row: DeploymentRow,
  stream: LogStream,
  message: string,
): Promise<void> {
  // Build output is untrusted; one runaway line must not bloat a row or a
  // socket frame (CLAUDE.md §8).
  const line = clampLogLine(message);
  const event = await deploymentRepo.insertDeploymentEvent({
    deploymentId: row.id,
    type: 'log',
    // The status is recorded on log rows too, so the WebSocket reconnect
    // replay can rebuild the exact frame that was published rather than
    // guessing which stage produced the line.
    status: row.status,
    stream,
    message: line,
  });
  await publish({
    type: 'log',
    deploymentId: row.id,
    projectId: row.project_id,
    orgId: row.org_id,
    status: row.status,
    stream,
    eventId: Number(event.id),
    message: line,
    at: new Date().toISOString(),
  });
}

/** Terminal failure: record the reason on the row and in the timeline. */
export async function failDeployment(
  row: DeploymentRow,
  code: string,
  message: string,
  log: Logger,
): Promise<DeploymentRow> {
  const startedAt = row.started_at ? new Date(row.started_at as unknown as string).getTime() : null;
  const finishedAt = new Date();
  log.warn({ deploymentId: row.id, code, from: row.status }, 'deployment failed');
  return transition(row, 'failed', {
    message: `${code}: ${message}`,
    force: true,
    patch: {
      error_code: code,
      error_message: message,
      finished_at: finishedAt,
      duration_ms: startedAt ? finishedAt.getTime() - startedAt : null,
    },
  });
}
