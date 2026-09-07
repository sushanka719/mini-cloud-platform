import { z } from 'zod';
import { deploymentStatusSchema } from './enums.js';

/**
 * The container half of the contract (Phase 7).
 *
 * Everything here is a *name* or a *shape* that more than one process has to
 * agree on: the labels the worker stamps on a container and the sweeper reads
 * back, the image tag Phase 8's rollback will re-create a container from, the
 * stats document the worker writes to Redis and the API reads, and the
 * container-action job the API produces and the worker consumes.
 *
 * `dockerode` itself is deliberately absent — ARCHITECTURE §9 keeps Docker
 * inside `apps/worker`, and this package is imported by the browser bundle.
 */

/**
 * Labels stamped on every image and container we create.
 *
 * These are the only reliable way to tell "ours" from "someone else's" on a
 * shared Docker daemon, which is what makes the boot-time orphan sweep safe:
 * without them the only alternative is matching on names, and a name is not a
 * claim of ownership.
 */
export const FORGE_LABELS = {
  managed: 'forge.managed',
  deployment: 'forge.deployment',
  project: 'forge.project',
  org: 'forge.org',
  attempt: 'forge.attempt',
} as const;

/** Value of `forge.managed` on everything we create. */
export const FORGE_MANAGED = 'true';

/**
 * The container's name.
 *
 * Derived from the deployment id rather than random, so a retry of the same
 * deployment collides with the container the previous attempt left behind —
 * which is what we want: the collision is detected and the stale container is
 * removed, instead of two containers quietly serving the same deployment.
 */
export function containerNameFor(deploymentId: string): string {
  return `forge-${deploymentId}`;
}

/**
 * Docker repository/tag names are far stricter than our slugs: lowercase, and
 * only `[a-z0-9._-]` in a path component. Anything else is folded to `-`.
 */
function dockerSafe(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 60) : 'app';
}

/**
 * `<prefix>/<slug>-<projectId8>` — readable in `docker images`, and unique
 * across orgs, which a bare slug is not (slugs are unique per org only).
 */
export function imageRepositoryFor(prefix: string, slug: string, projectId: string): string {
  return `${dockerSafe(prefix)}/${dockerSafe(slug)}-${projectId.slice(0, 8)}`;
}

/**
 * The full image reference for one deployment attempt.
 *
 * The attempt is part of the tag because a retry rebuilds the same deployment
 * id, and overwriting the previous attempt's image would destroy the only
 * artifact a rollback could go back to.
 */
export function imageTagFor(
  prefix: string,
  slug: string,
  projectId: string,
  deploymentId: string,
  attempt: number,
): string {
  return `${imageRepositoryFor(prefix, slug, projectId)}:${deploymentId.slice(0, 8)}-${attempt}`;
}

// --- runtime stats ----------------------------------------------------------

/**
 * One sample of a running container, as written to Redis by whichever worker
 * holds the monitor lock and read back by the API.
 *
 * Redis rather than Postgres because it is ephemeral by nature — a sample is
 * worthless a minute later, and a TTL is exactly the right expiry rule. Phase
 * 9 moves the same document onto the `metrics` WebSocket topic.
 */
export const containerStatsSchema = z.object({
  deploymentId: z.string().uuid(),
  containerId: z.string(),
  /** Percentage of one CPU core-equivalent, computed from two cumulative reads. */
  cpuPercent: z.number(),
  memoryBytes: z.number().int().nonnegative(),
  /** The container's memory cap, i.e. what we set — not the host's RAM. */
  memoryLimitBytes: z.number().int().nonnegative(),
  memoryPercent: z.number(),
  /** Processes inside the container, against `DOCKER_PIDS_LIMIT`. */
  pids: z.number().int().nonnegative(),
  pidsLimit: z.number().int().nonnegative(),
  /** Docker's own view of the container state, so a dead app is visible. */
  state: z.string(),
  at: z.string(),
});
export type ContainerStats = z.infer<typeof containerStatsSchema>;

/** A running deployment, as the dashboard's containers view needs it. */
export const containerSummarySchema = z.object({
  deploymentId: z.string().uuid(),
  projectId: z.string().uuid(),
  projectName: z.string(),
  projectSlug: z.string(),
  orgId: z.string().uuid(),
  status: deploymentStatusSchema,
  containerId: z.string().nullable(),
  imageTag: z.string().nullable(),
  url: z.string().nullable(),
  hostPort: z.number().int().nullable(),
  appPort: z.number().int(),
  healthPath: z.string(),
  attempt: z.number().int().nonnegative(),
  startedAt: z.string().nullable(),
  liveSince: z.string().nullable(),
  /** True when the project points at this deployment as the one serving. */
  isActive: z.boolean(),
  /** null when no sample is in Redis — a worker may be down, or Redis. */
  stats: containerStatsSchema.nullable(),
});
export type ContainerSummary = z.infer<typeof containerSummarySchema>;

// --- container actions ------------------------------------------------------

/**
 * What a user can ask of a running container.
 *
 * `stop` removes the container and settles the deployment as `stopped`;
 * `restart` restarts the *same* container in place and re-runs the health
 * check, so the deployment stays `live` throughout. Starting a *stopped*
 * deployment again from its stored image is Phase 8's rollback primitive and
 * deliberately not here.
 */
export const CONTAINER_ACTIONS = ['stop', 'restart'] as const;
export const containerActionSchema = z.enum(CONTAINER_ACTIONS);
export type ContainerAction = z.infer<typeof containerActionSchema>;

/**
 * The container-action job.
 *
 * The API cannot talk to Docker (ARCHITECTURE §9: "the API never imports
 * Docker or `child_process` logic"), so a stop is a job like a deploy is: the
 * API records the intent and enqueues, a worker executes it and publishes the
 * result. It rides its own queue rather than the `deployments` one so a stop
 * is never stuck behind a five-minute build, and so the deployments queue's
 * retry/idempotency semantics stay exactly as Phase 4 defined them.
 */
export const containerActionJobSchema = z.object({
  deploymentId: z.string().uuid(),
  projectId: z.string().uuid(),
  orgId: z.string().uuid(),
  action: containerActionSchema,
  requestedBy: z.string().uuid().nullable(),
});
export type ContainerActionJob = z.infer<typeof containerActionJobSchema>;

/** Response to a stop/restart request: the row plus what was enqueued. */
export const containerActionResultSchema = z.object({
  action: containerActionSchema,
  deploymentId: z.string().uuid(),
  /** False when the deployment was already in the requested state. */
  enqueued: z.boolean(),
  message: z.string(),
});
export type ContainerActionResult = z.infer<typeof containerActionResultSchema>;
