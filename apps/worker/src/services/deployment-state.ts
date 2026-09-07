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

  await recordStatus(updated, to, options.message ?? null);
  return updated;
}

/**
 * Steps 2 and 3 of a transition — append the event, publish it — for a status
 * the caller has *already* written.
 *
 * Split out for the writes that have to be conditional and therefore cannot go
 * through `transition()`'s unconditional update: the claim, and Phase 10's
 * orphan sweep. Both settle a race in Postgres with a `WHERE` clause and then
 * need the row's new state to reach the timeline and the dashboard by exactly
 * the same path every other transition uses.
 */
export async function recordStatus(
  row: DeploymentRow,
  status: DeploymentStatus,
  message: string | null,
): Promise<void> {
  const event = await deploymentRepo.insertDeploymentEvent({
    deploymentId: row.id,
    type: 'status',
    status,
    message,
  });

  await publish({
    type: 'status',
    deploymentId: row.id,
    projectId: row.project_id,
    orgId: row.org_id,
    status,
    eventId: Number(event.id),
    message,
    at: new Date().toISOString(),
  });
}

/** One line of pipeline output, before it has an id. */
export type PendingLogLine = { stream: LogStream; message: string };

/**
 * Persists and publishes a batch of log lines in one database round trip.
 *
 * Real build output arrives in bursts, and Phase 4's one-insert-per-line cost a
 * round trip per line — with `npm install` writing a few hundred, the database
 * became the pipeline's bottleneck. The rows come back in insert order, so the
 * ids stay monotonic in line order, which is what the dashboard's replay
 * cursor and de-duplication rely on.
 */
export async function logLines(
  row: DeploymentRow,
  lines: readonly PendingLogLine[],
): Promise<number> {
  if (lines.length === 0) return 0;

  // Build output is untrusted; one runaway line must not bloat a row or a
  // socket frame (CLAUDE.md §8).
  const clamped = lines.map((line) => ({ ...line, message: clampLogLine(line.message) }));

  const events = await deploymentRepo.insertDeploymentEvents(
    clamped.map((line) => ({
      deploymentId: row.id,
      type: 'log' as const,
      // The status is recorded on log rows too, so the WebSocket reconnect
      // replay can rebuild the exact frame that was published rather than
      // guessing which stage produced the line.
      status: row.status,
      stream: line.stream,
      message: line.message,
    })),
  );

  const at = new Date().toISOString();
  for (const [index, event] of events.entries()) {
    const line = clamped[index];
    if (!line) continue;
    await publish({
      type: 'log',
      deploymentId: row.id,
      projectId: row.project_id,
      orgId: row.org_id,
      status: row.status,
      stream: line.stream,
      eventId: Number(event.id),
      message: line.message,
      at,
    });
  }

  return events.length;
}

/** A single pipeline log line — the `system` lines the stages write themselves. */
export async function logLine(
  row: DeploymentRow,
  stream: LogStream,
  message: string,
): Promise<void> {
  await logLines(row, [{ stream, message }]);
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
