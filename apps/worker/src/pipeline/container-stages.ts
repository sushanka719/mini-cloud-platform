import { randomUUID } from 'node:crypto';
import { env, type Logger } from '@forge/config';
import { fileRepo, type DeploymentRow, type DeploymentUpdate, type FileRow, type ProjectRow, type ResolvedEnvVar } from '@forge/db';
import { artifactKey, gzipPathToObject } from '@forge/storage';
import {
  FORGE_LABELS,
  FORGE_MANAGED,
  imageTagFor,
  type DeploymentStatus,
} from '@forge/shared';
import type { BuildSandbox } from '../build/sandbox.js';
import type { LogSink } from '../build/log-sink.js';
import { containerEnvironment } from '../build/build-env.js';
import { objectStore } from '../lib/object-store.js';
import { createBuildContext, writeDockerfile } from '../docker/context.js';
import { buildDeploymentImage, ensureBaseImage, findLocalImage } from '../docker/image.js';
import {
  createDeploymentContainer,
  ensureDeploymentNetwork,
  inspectContainer,
  startContainer,
  stopAndRemoveContainer,
} from '../docker/container.js';
import { followContainerLogs, type ContainerLogFollower } from '../docker/container-logs.js';
import { StepAbortedError } from '../build/spawn-step.js';
import { waitForHealthy } from '../docker/health-check.js';
import { StageError } from './stage-error.js';

/**
 * `creating_container` → `starting` → `health_check`, for real.
 *
 * This is the phase's whole point, so the shape is worth stating plainly:
 *
 *  1. **`creating_container`** — tar the built tree, generate a Dockerfile,
 *     `docker build` it into a tagged image (streaming the daemon's output into
 *     the same log the build wrote to), optionally keep the tarball as the
 *     deployment's artifact, then create a container with every limit
 *     CLAUDE.md §8 asks for. Nothing is running yet.
 *  2. **`starting`** — start it, read back the host port Docker chose, and
 *     begin following its logs. From here the app's own output is in the
 *     browser.
 *  3. **`health_check`** — GET the project's `health_path` through the
 *     published port until 2xx, with a precondition that fails fast if the
 *     container has already exited.
 *
 * The container created here is owned by this function until it returns. Every
 * exit path that is not a success removes it — a failed deployment must not
 * leave something listening on a port.
 */

/**
 * Where this deployment's image comes from.
 *
 * A discriminated union rather than an optional `workdir` + optional `tag`,
 * because the two cases have nothing in common: `build` tars a tree and asks
 * the daemon to assemble an image from it, `reuse` names an image that already
 * exists. Making it a union means the stage cannot be called with a workdir it
 * will not read, or a tag it will overwrite.
 */
export type ImageSource =
  /** A normal deploy, and the artifact half of a rollback: build from a tree. */
  | { kind: 'build'; workdir: string }
  /**
   * The fast half of a rollback: create a container from the image a previous
   * deployment left behind. Nothing is tarred, nothing is built, no artifact is
   * written — this deployment produced no new bytes, and claiming otherwise
   * would put a second artifact row on the object store for one that already
   * exists.
   */
  | { kind: 'reuse'; tag: string; rolledBackFrom: string };

export type ContainerStagesInput = {
  deployment: DeploymentRow;
  project: ProjectRow;
  projectVars: readonly ResolvedEnvVar[];
  sandbox: BuildSandbox;
  /** Build from a tree, or reuse a previous deployment's image. */
  image: ImageSource;
  sink: LogSink;
  log: Logger;
  signal: AbortSignal;
  /** Advances the state machine, persisting and publishing (CLAUDE.md §7). */
  enter: (
    status: DeploymentStatus,
    message?: string,
    patch?: DeploymentUpdate,
  ) => Promise<DeploymentRow>;
  /** The `fail_at` demo hook, fired after the transition is recorded. */
  maybeFailHere: (status: DeploymentStatus) => Promise<void>;
};

export type ContainerStagesResult = {
  deployment: DeploymentRow;
  imageTag: string;
  imageId: string;
  containerId: string;
  hostPort: number;
  url: string;
  /** Null on a reused image: nothing new was built, so nothing was stored. */
  artifact: FileRow | null;
};

export async function runContainerStages(
  input: ContainerStagesInput,
): Promise<ContainerStagesResult> {
  const { project, sink, log } = input;
  let row = input.deployment;

  // --- creating_container ---------------------------------------------------
  row = await input.enter('creating_container');
  await input.maybeFailHere('creating_container');

  const network = await ensureDeploymentNetwork(log);

  const { imageTag, imageId, artifact } = await acquireImage(input, row);

  const runtime = containerEnvironment(row, project, input.projectVars);
  const { container, name } = await createDeploymentContainer({
    deploymentId: row.id,
    projectId: project.id,
    orgId: project.org_id,
    attempt: row.attempt,
    imageTag,
    appPort: project.app_port,
    env: runtime.vars,
    network,
  });
  await sink.system(
    `Container ${name} created: ${String(env.DOCKER_MEMORY_MB)}MB memory, ` +
      `${String(env.DOCKER_CPUS)} CPU, ${String(env.DOCKER_PIDS_LIMIT)} pids, ` +
      `network "${network}", non-root (1000:1000), all capabilities dropped` +
      `${env.DOCKER_READONLY_ROOTFS ? ', read-only root fs' : ''}`,
  );
  await sink.system(
    `Runtime environment: ${String(Object.keys(runtime.vars).length)} variables ` +
      `(${String(runtime.visibleKeys.length)} project, ${String(runtime.secretKeys.length)} secret` +
      `${runtime.secretKeys.length > 0 ? `: ${runtime.secretKeys.join(', ')} — values masked` : ''})`,
  );

  let follower: ContainerLogFollower | null = null;
  let succeeded = false;

  try {
    // --- starting -----------------------------------------------------------
    row = await input.enter('starting', undefined, {
      container_id: container.id,
      image_tag: imageTag,
    });
    sink.setRow(row);
    await input.maybeFailHere('starting');

    await sink.system(`$ docker start ${name}`);
    await startContainer(container);

    const state = await inspectContainer(container.id, project.app_port);
    if (!state) {
      throw new StageError('CONTAINER_GONE', 'The container disappeared immediately after starting');
    }
    if (state.hostPort === null) {
      throw new StageError(
        'PORT_NOT_PUBLISHED',
        `The container started but port ${String(project.app_port)} was not published on the host`,
      );
    }

    const url = `http://localhost:${String(state.hostPort)}`;
    row = await input.enter(
      'health_check',
      `GET ${url}${project.health_path} until 2xx (timeout ${String(project.health_timeout_ms)}ms)`,
      { host_port: state.hostPort, url },
    );
    sink.setRow(row);

    // Started *before* the health check and read *during* it: this is why a
    // crash-looping app shows its stack trace in the browser rather than only
    // a HEALTH_CHECK_FAILED once the budget is spent.
    follower = await followContainerLogs({
      container,
      sink,
      log,
      maxLines: env.DOCKER_MAX_RUNTIME_LOG_LINES,
    });

    await input.maybeFailHere('health_check');

    const health = await waitForHealthy({
      hostPort: state.hostPort,
      healthPath: project.health_path,
      timeoutMs: project.health_timeout_ms,
      log,
      signal: input.signal,
      // Fail fast on an exited container: polling a port nothing is listening
      // on for thirty seconds and then reporting a timeout sends the reader
      // looking in the wrong place.
      precondition: async () => {
        const current = await inspectContainer(container.id, project.app_port);
        if (!current) return 'the container no longer exists';
        if (current.oomKilled) {
          return `the container was killed for exceeding its ${String(env.DOCKER_MEMORY_MB)}MB memory limit`;
        }
        if (!current.running) {
          return `the container exited with code ${String(current.exitCode ?? -1)}${current.error ? ` (${current.error})` : ''}`;
        }
        return null;
      },
      onAttempt: async (attempt, probe) => {
        await sink.system(
          `Health check attempt ${String(attempt)}: ` +
            (probe.ok
              ? `${String(probe.statusCode)} OK in ${String(probe.durationMs)}ms`
              : `${probe.error ?? 'no response'} (${String(probe.durationMs)}ms)`),
        );
      },
    });

    if (health.aborted) {
      // Not an unhealthy app: the worker is leaving. Same code the build steps
      // use, so "a shutdown killed this deployment" reads the same wherever it
      // happened, and Phase 8's retry sees one retryable reason.
      throw new StepAbortedError(
        'The health check was stopped because the worker is shutting down',
      );
    }
    if (!health.ok) {
      throw new StageError(
        'HEALTH_CHECK_FAILED',
        `${project.health_path} did not answer 2xx within ${String(project.health_timeout_ms)}ms ` +
          `after ${String(health.attempts)} attempts: ${health.lastError ?? 'no response'}`,
        // A slow first boot is a plausible one-off, so Phase 8 may retry it.
        { retryable: true },
      );
    }

    await sink.system(
      `Health check passed after ${String(health.attempts)} attempts in ${String(health.durationMs)}ms`,
    );

    succeeded = true;
    return {
      deployment: row,
      imageTag,
      imageId,
      containerId: container.id,
      hostPort: state.hostPort,
      url,
      artifact,
    };
  } finally {
    // Stop reading the container's output either way: on success the deployment
    // is live and its runtime logs are no longer part of *this* timeline, and
    // on failure the socket has to be closed before the container is removed.
    if (follower) {
      follower.stop();
      await follower.done.catch(() => undefined);
      if (follower.truncated()) {
        await sink
          .system(
            `[container output truncated after ${String(env.DOCKER_MAX_RUNTIME_LOG_LINES)} lines]`,
          )
          .catch(() => undefined);
      }
    }
    if (!succeeded) {
      // Nothing that failed gets to keep a port. The image is kept: it is the
      // only evidence of what was built, and `docker run` on it is how someone
      // debugs a container that would not start.
      const removed = await stopAndRemoveContainer(container.id, log);
      log.info({ containerId: container.id.slice(0, 12), removed }, 'cleaned up failed container');
      await sink
        .system(`Removed container ${name} after the failure`)
        .catch(() => undefined);
    }
  }
}

type AcquiredImage = { imageTag: string; imageId: string; artifact: FileRow | null };

/**
 * Gets an image for this deployment — by building one, or by adopting one that
 * already exists.
 *
 * The `build` path is Phase 7's, unchanged: generate a Dockerfile, tar the
 * built tree, hand it to the daemon, then store the tar as the deployment's
 * artifact. It runs for every normal deploy and for the half of a rollback
 * whose image was pruned (the extracted artifact *is* a built tree).
 *
 * The `reuse` path is Phase 8's rollback shortcut, and its whole value is what
 * it does **not** do: no Dockerfile, no tar, no `docker build`, no artifact.
 * The image a previous deployment left behind is byte-for-byte what was proven
 * to work, so rebuilding it would be slower, would produce a *different* image
 * (timestamps, resolved dependencies), and would defeat the point of a rollback
 * being the fast escape hatch. `ensureBaseImage` is skipped too: a complete
 * image has no `FROM` left to resolve.
 *
 * The reused tag is not re-tagged for this deployment. Two deployments then
 * name one image, which is correct — they *are* the same image — and it is why
 * `pruneProjectImages` removes by count rather than by "is any deployment still
 * pointing at this?".
 */
async function acquireImage(
  input: ContainerStagesInput,
  row: DeploymentRow,
): Promise<AcquiredImage> {
  const { project, sink, log } = input;

  if (input.image.kind === 'reuse') {
    const tag = input.image.tag;
    await sink.system(
      `Rolling back to deployment ${input.image.rolledBackFrom.slice(0, 8)}: reusing its image ${tag}`,
    );
    const found = await findLocalImage(tag);
    if (!found) {
      // The caller checked this before choosing `reuse`, so getting here means
      // the image was removed in between — a real race with `docker rmi` or a
      // prune, not a mistake. Retryable: the artifact fallback is chosen fresh
      // on the next attempt.
      throw new StageError(
        'ROLLBACK_IMAGE_MISSING',
        `The image ${tag} is no longer on this Docker host`,
        { retryable: true },
      );
    }
    await sink.system(
      `Image ${tag} present (${found.imageId.slice(7, 19)}, ${String(found.sizeBytes)} bytes) — ` +
        'nothing to clone, install or build',
    );
    return { imageTag: tag, imageId: found.imageId, artifact: null };
  }

  const workdir = input.image.workdir;
  await ensureBaseImage(sink, log);

  // Stamped on both the image and the container: the sweeper and every
  // `docker` query we run identify our objects by label, never by name.
  const labels = {
    [FORGE_LABELS.managed]: FORGE_MANAGED,
    [FORGE_LABELS.deployment]: row.id,
    [FORGE_LABELS.project]: project.id,
    [FORGE_LABELS.org]: project.org_id,
    [FORGE_LABELS.attempt]: String(row.attempt),
  };

  const dockerfile = await writeDockerfile(
    input.sandbox,
    workdir,
    project,
    env.DOCKER_BASE_IMAGE,
    labels,
  );
  // The generated Dockerfile goes in the log verbatim: it is the honest answer
  // to "what exactly is my app running as?", and it is short.
  for (const line of dockerfile.trimEnd().split('\n')) {
    await sink.line('system', `  ${line}`);
  }

  const context = await createBuildContext(input.sandbox, workdir, env.DOCKER_MAX_CONTEXT_BYTES);
  await sink.system(`Build context: ${String(context.sizeBytes)} bytes`);

  // The tag carries the deployment id *and* the attempt: a retry must not
  // overwrite the only image an earlier attempt — or a rollback — could go
  // back to.
  const imageTag = imageTagFor(
    env.DOCKER_IMAGE_PREFIX,
    project.slug,
    project.id,
    row.id,
    row.attempt,
  );
  await sink.system(`$ docker build -t ${imageTag} .`);

  const image = await buildDeploymentImage({
    tag: imageTag,
    contextPath: context.path,
    sink,
    log,
    timeoutMs: env.DOCKER_BUILD_TIMEOUT_MS,
    signal: input.signal,
  });
  await sink.system(
    `Image ${image.tag} built in ${String(image.durationMs)}ms ` +
      `(${image.imageId.slice(7, 19)}, ${String(image.sizeBytes)} bytes)`,
  );

  // The artifact is stored *after* the image is proven and *before* anything is
  // started: it is the durable copy of exactly the tree that went into that
  // image, which is what a rollback needs once this sandbox is gone.
  const artifact = await storeArtifact(row, project, context.path, context.sizeBytes, sink, log);

  return { imageTag, imageId: image.imageId, artifact };
}

/**
 * Stores the build context as the deployment's gzip artifact.
 *
 * Never fatal. An artifact is a convenience for a *later* rollback; failing a
 * healthy deployment because the object store was full would trade a working
 * app for a missing file.
 */
async function storeArtifact(
  row: DeploymentRow,
  project: ProjectRow,
  contextPath: string,
  contextBytes: number,
  sink: LogSink,
  log: Logger,
): Promise<FileRow | null> {
  if (!env.DOCKER_STORE_ARTIFACT) return null;

  try {
    const key = artifactKey(project.org_id, project.id, `${randomUUID()}.tar.gz`);
    // gzip runs on a worker_threads thread (Phase 3's pool): a 40 MB
    // node_modules tarball is seconds of pure CPU, and this process still has a
    // heartbeat to write and log lines to publish.
    const result = await gzipPathToObject(objectStore, contextPath, key, {
      level: env.GZIP_LEVEL,
    });

    const file = await fileRepo.insertFile({
      projectId: project.id,
      deploymentId: row.id,
      kind: 'artifact',
      storagePath: result.key,
      sizeBytes: result.outputBytes,
      checksum: result.outputChecksum,
      contentType: 'application/gzip',
      originalName: `${project.slug}-${row.id.slice(0, 8)}-attempt-${String(row.attempt)}.tar.gz`,
      compression: 'gzip',
      uncompressedBytes: result.inputBytes,
      uncompressedChecksum: result.inputChecksum,
    });

    await sink.system(
      `Artifact stored: ${String(result.outputBytes)} bytes gzipped from ${String(contextBytes)} ` +
        `(${(result.ratio * 100).toFixed(1)}%, ${String(result.durationMs)}ms on thread ${String(result.threadId)})`,
    );
    return file;
  } catch (err) {
    log.warn({ err, deploymentId: row.id }, 'could not store the deployment artifact');
    await sink
      .system('Could not store the build artifact; the deployment continues without one')
      .catch(() => undefined);
    return null;
  }
}
