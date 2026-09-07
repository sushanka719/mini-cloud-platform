import { env, type Logger } from '@forge/config';
import {
  deploymentRepo,
  envVarRepo,
  fileRepo,
  type DeploymentRow,
  type DeploymentUpdate,
  type FileRow,
  type ProjectRow,
  type ResolvedEnvVar,
} from '@forge/db';
import {
  DEPLOYMENT_STATUS_LABELS,
  describeStepResult,
  imageRepositoryFor,
  isAppError,
  secretRedactionRules,
  type DeploymentStatus,
  type RedactionRule,
  type StepResult,
} from '@forge/shared';
import { transition } from '../services/deployment-state.js';
import { objectStore } from '../lib/object-store.js';
import { BuildSandbox } from '../build/sandbox.js';
import { extractArchive, materializeArchive } from '../build/archive.js';
import { LogSink } from '../build/log-sink.js';
import { buildEnvironment } from '../build/build-env.js';
import { runStep, StepAbortedError } from '../build/spawn-step.js';
import { createBuildAbort } from '../build/active-builds.js';
import { findLocalImage, pruneProjectImages } from '../docker/image.js';
import { stopAndRemoveContainer } from '../docker/container.js';
import { forgetContainerStats } from '../services/container-stats.js';
import { ProjectLock } from '../services/project-lock.js';
import { runContainerStages, type ImageSource } from './container-stages.js';
import { StageError } from './stage-error.js';

/**
 * The deployment pipeline.
 *
 * Every stage is real as of Phase 7. `cloning`/`installing`/`building` unpack
 * the source into a sandbox and run the project's own commands under `spawn`
 * (Phase 6); `creating_container`/`starting`/`health_check` build an image and
 * run it under `dockerode` (`container-stages.ts`).
 *
 * Phase 8 added a second way in. A deployment carrying `parent_deployment_id`
 * is a **rollback**, and it does not build: it adopts the image the target
 * deployment left behind, or — if that image has been pruned — extracts the
 * target's stored artifact and rebuilds from exactly those bytes. Both paths
 * converge on the same container stages and the same swap, so "going live" has
 * one implementation regardless of where the image came from.
 *
 * Three invariants hold throughout:
 *  - every stage transition is persisted *and* published (CLAUDE.md §7), which
 *    is `transition()`'s job, not this file's;
 *  - the sandbox, the log object, the project lock and any container this
 *    attempt created are cleaned up on every exit path, including a failure
 *    inside a failure;
 *  - the container stages hold `lock:project:<id>` from before the image is
 *    built until after the active-deployment pointer has moved, so two
 *    deployments of one project cannot both end up serving.
 */

/**
 * Host paths that must not reach a build log or an API response.
 *
 * Build tools print absolute paths freely — `npm` names its debug log file on
 * every failure — and those describe *our* filesystem layout, which is not the
 * project's business. Replacing the roots keeps the useful part of the path.
 */
const PATH_REDACTIONS: RedactionRule[] = [
  { value: env.BUILD_ROOT, mask: '<sandbox>' },
  { value: env.STORAGE_ROOT, mask: '<storage>' },
];

/** Applies the same masking to a message that never went through the sink. */
function scrubPaths(message: string): string {
  let out = message;
  for (const rule of PATH_REDACTIONS) {
    if (out.includes(rule.value)) out = out.split(rule.value).join(rule.mask);
  }
  return out;
}

export type PipelineResult = {
  deployment: DeploymentRow;
  /** The stored build log, when it could be written. */
  logFile: FileRow | null;
};

export async function runDeployPipeline(
  deployment: DeploymentRow,
  project: ProjectRow,
  log: Logger,
): Promise<PipelineResult> {
  let row = deployment;

  // Secrets are needed before the log sink exists, because the sink has to
  // know what to mask from the very first line.
  const projectVars = await envVarRepo.resolveEnvForBuild(project.id);

  const sandbox = await BuildSandbox.create(env.BUILD_ROOT, deployment.id);
  const sink = await LogSink.open({
    store: objectStore,
    deployment: row,
    redactions: [
      ...secretRedactionRules(projectVars.filter((v) => v.isSecret).map((v) => v.value)),
      ...PATH_REDACTIONS,
    ],
    log,
  });
  const { controller, release } = createBuildAbort();

  /**
   * Held from just before the image is built until after the active-deployment
   * pointer has moved. Acquired inside the `try` rather than here so a failure
   * to take it is reported through the same log and the same `failed` row as
   * any other stage failure.
   */
  let lock: ProjectLock | null = null;
  /** Set once a container exists, so the failure path can remove it. */
  let liveContainerId: string | null = null;

  /** Advances the state machine and keeps the sink's status in step. */
  const enter = async (
    status: DeploymentStatus,
    message?: string,
    patch?: DeploymentUpdate,
  ): Promise<DeploymentRow> => {
    row = await transition(row, status, {
      message: message ?? DEPLOYMENT_STATUS_LABELS[status],
      ...(patch ? { patch } : {}),
    });
    sink.setRow(row);
    log.info({ deploymentId: row.id, status }, 'stage');
    return row;
  };

  /**
   * The demo hook: fail after entering the stage, so the timeline shows it.
   *
   * Classified **retryable** (Phase 8), which is a deliberate choice worth
   * stating. An injected failure is deterministic — `fail_at` is on the row, so
   * every attempt hits it — and one could argue it should skip the retries. But
   * this hook exists to make the resilience machinery visible from a button,
   * and a single click that produces attempt 1 → 5s → attempt 2 → 10s →
   * attempt 3 → dead-letter demonstrates retry, backoff and the DLQ hop in one
   * run. A genuinely *non*-retryable failure needs no simulation: a project
   * whose build command exits non-zero is one, and that is what the
   * "not retryable, no attempts spent" path is exercised with.
   */
  const maybeFailHere = async (status: DeploymentStatus): Promise<void> => {
    if (row.fail_at !== status) return;
    await sink.system(`Injected failure requested at "${status}"`);
    throw new StageError(
      `${status.toUpperCase()}_FAILED`,
      `Injected failure during ${status}`,
      { retryable: true },
    );
  };

  const isRollback = row.parent_deployment_id !== null;

  try {
    // --- source → an image source -------------------------------------------
    // Two ways in. A normal deploy clones, installs and builds; a rollback
    // reaches for an image that already exists (and only extracts the stored
    // artifact if that image has been pruned). Both hand back an `ImageSource`,
    // which is the only thing everything below cares about.
    const imageSource = isRollback
      ? await prepareRollback({ row, project, sandbox, sink, log, enter, maybeFailHere })
      : await prepareBuild({
          row,
          project,
          projectVars,
          sandbox,
          sink,
          log,
          enter,
          maybeFailHere,
          signal: controller.signal,
        });

    // --- container stages ---------------------------------------------------
    // The lock is taken before anything is created, not before the swap: two
    // deployments of one project must not both be building images and binding
    // ports, and the wait is what makes a double-click serialise rather than
    // race.
    lock = await ProjectLock.acquire(project.id, {
      ttlMs: env.DOCKER_LOCK_TTL_MS,
      waitMs: env.DOCKER_LOCK_WAIT_MS,
      log,
    });
    if (!lock) {
      throw new StageError(
        'PROJECT_LOCKED',
        `Another deployment of this project held its lock for more than ${String(env.DOCKER_LOCK_WAIT_MS)}ms`,
        { retryable: true },
      );
    }

    const container = await runContainerStages({
      deployment: row,
      project,
      projectVars,
      sandbox,
      image: imageSource,
      sink,
      log,
      signal: controller.signal,
      enter,
      maybeFailHere,
    });
    row = container.deployment;
    liveContainerId = container.containerId;

    // --- live ---------------------------------------------------------------
    // The swap, in this order and still under the lock: read what the project
    // points at *now*, point it at us, then take the old container down. Any
    // other order either leaves two containers claiming to serve or leaves a
    // gap where the project points at nothing.
    const previous = await deploymentRepo.findActiveDeployment(project.id);

    const startedAt = row.started_at
      ? new Date(row.started_at as unknown as string).getTime()
      : null;
    const finishedAt = new Date();

    row = await transition(row, 'live', {
      message: isRollback
        ? `Rolled back to ${String(row.parent_deployment_id).slice(0, 8)} and live at ${container.url}`
        : `Deployment is live at ${container.url}`,
      patch: {
        finished_at: finishedAt,
        duration_ms: startedAt ? finishedAt.getTime() - startedAt : null,
        container_id: container.containerId,
        image_tag: container.imageTag,
        host_port: container.hostPort,
        url: container.url,
        // Cleared here as well as on the re-queue, so "live *and* carrying an
        // error code" is not a row the database can hold however it got here.
        error_code: null,
        error_message: null,
        dead_lettered_at: null,
      },
    });
    sink.setRow(row);
    await deploymentRepo.setActiveDeployment(project.id, row.id);
    await sink.system(
      `Live at ${container.url}${project.health_path} in ${String(row.duration_ms ?? 0)}ms ` +
        `(container ${container.containerId.slice(0, 12)}, host port ${String(container.hostPort)})`,
    );

    if (previous && previous.id !== row.id) {
      // A rollback retires what it replaced as `rolled_back`, not `stopped`.
      // Both mean "no longer serving", but only one says *why*, and the
      // difference is what makes the deployment it was rolled back to
      // identifiable in the history months later.
      await retirePreviousDeployment(previous, project, container.url, isRollback, sink, log);
    }

    if (isRollback) {
      // Deliberately not pruned. A rollback reaches *backwards* through the
      // image history, and the image it just adopted is by definition one of
      // the oldest — pruning by count here could untag the image now serving
      // (the removal would fail while the container holds it, then succeed the
      // moment it stops) and would shrink the reach of the next rollback right
      // after proving that reach was worth having.
      log.info({ deploymentId: row.id }, 'skipping image prune: this deployment is a rollback');
    } else {
      // Only now: the image a rollback would want is the *previous* one, so
      // pruning before the new deployment is proven would delete the escape
      // hatch.
      await pruneProjectImages(
        imageRepositoryFor(env.DOCKER_IMAGE_PREFIX, project.slug, project.id),
        env.DOCKER_KEEP_IMAGES,
        log,
      );
    }

    const logFile = await sink.close();
    return { deployment: row, logFile };
  } catch (err) {
    // `runContainerStages` removes the container it created on its own failure
    // paths, so a container id here means it *succeeded* and something after it
    // did not — the `live` write, the pointer swap. The deployment is about to
    // be recorded as failed, so it must not leave something listening.
    if (liveContainerId) {
      await stopAndRemoveContainer(liveContainerId, log);
      await forgetContainerStats(row.id);
      log.warn(
        { deploymentId: row.id, containerId: liveContainerId.slice(0, 12) },
        'removed the container of a deployment that failed after starting it',
      );
    }
    // The log of a failed build is the most useful log there is, so it is
    // committed on this path too. The pipeline's own error is what propagates.
    await sink
      .system(`Pipeline stopped: ${err instanceof Error ? err.message : String(err)}`)
      .catch(() => undefined);
    await sink.close().catch(() => undefined);
    throw normalizeError(err);
  } finally {
    release();
    // Released after the swap, never before: the window the lock has to cover
    // is "a container exists but the project does not point at it yet".
    if (lock) await lock.release();
    if (env.BUILD_KEEP_SANDBOX) {
      log.info({ sandbox: sandbox.root }, 'keeping build sandbox (BUILD_KEEP_SANDBOX)');
    } else {
      await sandbox.dispose();
    }
  }
}

/**
 * Takes the deployment this one replaced out of service.
 *
 * "One live container per project" is only true if the old one actually goes
 * away, and it has to go away *after* the pointer moved — otherwise the project
 * has a moment with nothing serving it. `live → stopped` and `live →
 * rolled_back` are both legal transitions, so the old deployment settles
 * honestly rather than being left claiming to be live with no container behind
 * it.
 *
 * Which of the two it gets is the whole reason `rolled_back` exists in the
 * state machine: `stopped` is what a newer deployment does to an older one,
 * `rolled_back` is what an older deployment does to a newer one. A history
 * that only ever said `stopped` could not tell you which deployments were
 * *rejected*, which is exactly the question a rollback is asked to answer.
 *
 * Never fatal: the new deployment is already live, and turning that into a
 * failure because an old container would not die would be the wrong trade.
 */
async function retirePreviousDeployment(
  previous: DeploymentRow,
  project: ProjectRow,
  newUrl: string,
  wasRolledBack: boolean,
  sink: LogSink,
  log: Logger,
): Promise<void> {
  try {
    if (previous.container_id) {
      const removed = await stopAndRemoveContainer(previous.container_id, log);
      log.info(
        { deploymentId: previous.id, containerId: previous.container_id.slice(0, 12), removed },
        'retired the previous container',
      );
      await forgetContainerStats(previous.id);
    }
    if (previous.status === 'live') {
      await transition(previous, wasRolledBack ? 'rolled_back' : 'stopped', {
        message: wasRolledBack
          ? `Rolled back: replaced by an earlier deployment now serving ${newUrl}`
          : `Replaced by a newer deployment now serving ${newUrl}`,
        patch: { finished_at: new Date() },
      });
    }
    await sink.system(
      `Previous deployment ${previous.id.slice(0, 8)} ` +
        `${wasRolledBack ? 'rolled back' : 'stopped'} and its container removed`,
    );
  } catch (err) {
    log.warn({ err, deploymentId: previous.id }, 'could not retire the previous deployment');
    await sink
      .system(`Could not fully retire the previous deployment ${previous.id.slice(0, 8)}`)
      .catch(() => undefined);
  }
}

/** What both preparation paths are handed. */
type PrepareContext = {
  row: DeploymentRow;
  project: ProjectRow;
  sandbox: BuildSandbox;
  sink: LogSink;
  log: Logger;
  enter: (
    status: DeploymentStatus,
    message?: string,
    patch?: DeploymentUpdate,
  ) => Promise<DeploymentRow>;
  maybeFailHere: (status: DeploymentStatus) => Promise<void>;
};

/**
 * The normal path: `cloning` → `installing` → `building`, ending in a tree the
 * container stages will turn into an image.
 *
 * Lifted out of `runDeployPipeline` verbatim when the rollback path arrived —
 * the two are alternatives, and reading them as two named functions beats
 * reading one function with a 70-line `if`.
 */
async function prepareBuild(
  ctx: PrepareContext & { projectVars: readonly ResolvedEnvVar[]; signal: AbortSignal },
): Promise<ImageSource> {
  const { project, sandbox, sink, log } = ctx;

  // --- cloning --------------------------------------------------------------
  const row = await ctx.enter('cloning');
  await ctx.maybeFailHere('cloning');
  const workdir = await cloneSource(row, project, sandbox, sink, log);

  const environment = await buildEnvironment(sandbox, row, project, ctx.projectVars);
  await sink.system(
    `Build environment: ${Object.keys(environment.vars).length} variables ` +
      `(${environment.visibleKeys.length} project, ${environment.secretKeys.length} secret` +
      `${environment.secretKeys.length > 0 ? `: ${environment.secretKeys.join(', ')} — values masked` : ''})`,
  );

  // --- installing -----------------------------------------------------------
  await ctx.enter('installing');
  await ctx.maybeFailHere('installing');
  await runPipelineStep({
    label: 'install',
    command: project.install_command,
    timeoutMs: env.BUILD_INSTALL_TIMEOUT_MS,
    failureCode: 'INSTALL_FAILED',
    cwd: workdir,
    environment: environment.vars,
    sink,
    log,
    signal: ctx.signal,
  });

  // --- building -------------------------------------------------------------
  await ctx.enter('building');
  await ctx.maybeFailHere('building');
  await runPipelineStep({
    label: 'build',
    command: project.build_command,
    timeoutMs: env.BUILD_BUILD_TIMEOUT_MS,
    failureCode: 'BUILD_FAILED',
    cwd: workdir,
    environment: environment.vars,
    sink,
    log,
    signal: ctx.signal,
  });

  return { kind: 'build', workdir };
}

/**
 * The rollback path: get back to what a previous deployment was running.
 *
 * Two sources, tried in that order, because they are not equivalent:
 *
 *  1. **The image**, if it is still on this Docker host. It is byte-for-byte
 *     what was proven to work, and adopting it skips clone, install, build and
 *     `docker build` entirely — a rollback in seconds, which is the whole
 *     point of having one. No stage between `assigned` and
 *     `creating_container` is entered, because none of them happens.
 *  2. **The stored artifact**, if the image has been pruned. `pruneProjectImages`
 *     keeps only `DOCKER_KEEP_IMAGES` per project, so a tag outliving its image
 *     is ordinary rather than exceptional. The artifact is the gzipped tree that
 *     went *into* that image, so extracting it and rebuilding reproduces the
 *     same app from the same bytes — slower, and not the identical image, but
 *     still a rollback rather than a rebuild from source. That extraction is
 *     recorded as `cloning`, which is what it is; `installing` and `building`
 *     are still skipped, because their output is already inside the artifact.
 *
 * With neither, the rollback fails before anything is created and says which
 * of the two was missing. That is a real outcome the dashboard predicts — it
 * only offers targets that still have one — rather than a surprise.
 */
async function prepareRollback(ctx: PrepareContext): Promise<ImageSource> {
  const { row, project, sandbox, sink, log } = ctx;
  const targetId = row.parent_deployment_id;
  if (!targetId) {
    throw new StageError('ROLLBACK_TARGET_MISSING', 'This rollback names no target deployment');
  }

  const target = await deploymentRepo.findDeploymentById(targetId);
  if (!target) {
    throw new StageError(
      'ROLLBACK_TARGET_GONE',
      `The deployment this rolls back to (${targetId.slice(0, 8)}) no longer exists`,
    );
  }
  // The id came from our own row, but a cross-project read here would be a
  // tenancy hole, so it is checked rather than assumed (same reasoning as
  // `cloneSource`'s source-file check).
  if (target.project_id !== project.id) {
    throw new StageError(
      'ROLLBACK_TARGET_GONE',
      'The deployment this rolls back to belongs to another project',
    );
  }

  await sink.system(
    `Rollback target: deployment ${target.id.slice(0, 8)} (attempt ${String(target.attempt)}, ` +
      `status "${target.status}", image ${target.image_tag ?? 'none recorded'})`,
  );

  // 1. The image. `row.image_tag` was copied from the target when the rollback
  //    was created, so this survives the target row changing underneath us.
  const tag = row.image_tag ?? target.image_tag;
  if (tag) {
    const found = await findLocalImage(tag);
    if (found) return { kind: 'reuse', tag, rolledBackFrom: target.id };
    await sink.system(
      `Image ${tag} is no longer on this Docker host (pruned by DOCKER_KEEP_IMAGES=` +
        `${String(env.DOCKER_KEEP_IMAGES)}); falling back to the stored artifact`,
    );
  }

  // 2. The artifact.
  const artifact = (await fileRepo.listDeploymentFiles(target.id)).find(
    (file) => file.kind === 'artifact',
  );
  if (!artifact) {
    throw new StageError(
      'ROLLBACK_SOURCE_GONE',
      tag
        ? `The image ${tag} has been pruned and deployment ${target.id.slice(0, 8)} kept no artifact, so there is nothing to roll back to`
        : `Deployment ${target.id.slice(0, 8)} recorded neither an image nor an artifact, so there is nothing to roll back to`,
    );
  }

  await ctx.enter(
    'cloning',
    `Restoring deployment ${target.id.slice(0, 8)} from its stored artifact ` +
      `(${String(artifact.size_bytes)} bytes gzipped)`,
  );
  await ctx.maybeFailHere('cloning');

  const objectPath = await objectStore.resolveExistingKey(artifact.storage_path);
  await sink.system(
    `Artifact: ${artifact.original_name ?? artifact.storage_path} ` +
      `(${String(artifact.size_bytes)} bytes, sha256 ${artifact.checksum?.slice(0, 16) ?? '?'}…)`,
  );

  const archivePath = await materializeArchive(sandbox, objectPath, artifact.compression);
  const extracted = await extractArchive(archivePath, sandbox, sandbox.sourceDir, {
    maxBytes: env.BUILD_MAX_EXTRACT_BYTES,
    maxFiles: env.BUILD_MAX_EXTRACT_FILES,
  });
  await sink.system(
    `Restored ${extracted.files} files / ${extracted.directories} directories ` +
      `(${extracted.bytes} bytes) — install and build are skipped: their output is in the artifact`,
  );
  for (const skipped of extracted.skipped) {
    await sink.system(`Refused artifact entry: ${skipped}`);
  }

  // `sandbox.sourceDir` directly, *not* `resolveWorkdir(project.root_dir)`:
  // the artifact is a tar of the workdir the original build produced, so
  // `root_dir` has already been applied to it. Applying it a second time would
  // look for `apps/web/apps/web`.
  log.debug({ deploymentId: row.id, workdir: sandbox.sourceDir }, 'artifact restored');
  return { kind: 'build', workdir: sandbox.sourceDir };
}

/**
 * `cloning`: get the project's source into the sandbox.
 *
 * For an upload that means resolving the stored object (through the object
 * store, so containment is checked) and unpacking it. For a git project it
 * means nothing yet — git intake was deferred in Phase 2 — and saying so
 * plainly beats a confusing archive error.
 */
async function cloneSource(
  row: DeploymentRow,
  project: ProjectRow,
  sandbox: BuildSandbox,
  sink: LogSink,
  log: Logger,
): Promise<string> {
  if (project.source_type === 'git') {
    throw new StageError(
      'GIT_SOURCE_UNSUPPORTED',
      'Git sources are not implemented yet; upload a source archive instead',
    );
  }
  if (!row.source_file_id) {
    throw new StageError('NO_SOURCE', 'This deployment has no source archive to build');
  }

  const file = await fileRepo.findFileById(row.source_file_id);
  if (!file) {
    throw new StageError('SOURCE_NOT_FOUND', 'The source archive record no longer exists');
  }
  if (file.project_id !== project.id) {
    // Belt and braces: the id came from our own row, but a cross-project read
    // here would be a tenancy hole, so it is checked rather than assumed.
    throw new StageError('SOURCE_NOT_FOUND', 'The source archive belongs to another project');
  }

  const objectPath = await objectStore.resolveExistingKey(file.storage_path);
  await sink.system(
    `Source: ${file.original_name ?? file.storage_path} (${file.size_bytes} bytes, sha256 ${file.checksum?.slice(0, 16) ?? '?'}…)`,
  );

  const archivePath = await materializeArchive(sandbox, objectPath, file.compression);
  const extracted = await extractArchive(archivePath, sandbox, sandbox.sourceDir, {
    maxBytes: env.BUILD_MAX_EXTRACT_BYTES,
    maxFiles: env.BUILD_MAX_EXTRACT_FILES,
  });

  await sink.system(
    `Extracted ${extracted.files} files / ${extracted.directories} directories ` +
      `(${extracted.bytes} bytes, ${extracted.format})`,
  );
  for (const skipped of extracted.skipped) {
    // Refused entries are reported, not hidden: a traversal attempt is
    // something the project owner should see in their own build log.
    await sink.system(`Refused archive entry: ${skipped}`);
  }

  const { dir, descendedInto } = await sandbox.resolveWorkdir(project.root_dir);
  if (descendedInto) {
    await sink.system(
      `Archive has a single top-level directory "${descendedInto}"; using it as the source root`,
    );
  }
  await sink.system(
    `Working directory: ${project.root_dir === '.' ? (descendedInto ?? '.') : project.root_dir}`,
  );
  log.debug({ deploymentId: row.id, workdir: dir }, 'source ready');
  return dir;
}

type PipelineStepOptions = {
  label: string;
  command: string;
  timeoutMs: number;
  failureCode: string;
  cwd: string;
  environment: Record<string, string>;
  sink: LogSink;
  log: Logger;
  signal: AbortSignal;
};

/**
 * Runs one command and turns its outcome into either "carry on" or a
 * `StageError` carrying why.
 *
 * A timeout, a non-zero exit and a signal death are three different failures
 * and get three different codes — "BUILD_FAILED exit 1" and
 * "BUILD_TIMEOUT after 300000ms" call for different fixes.
 */
async function runPipelineStep(options: PipelineStepOptions): Promise<StepResult> {
  await options.sink.system(`$ ${options.command}`);

  const result = await runStep({
    command: options.command,
    cwd: options.cwd,
    env: options.environment,
    timeoutMs: options.timeoutMs,
    sink: options.sink,
    log: options.log,
    signal: options.signal,
  });

  await options.sink.system(describeStepResult(result));
  options.log.info(
    {
      step: options.label,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      lines: result.linesOut + result.linesErr,
    },
    'build step finished',
  );

  if (result.timedOut) {
    throw new StageError(
      `${options.failureCode.replace('_FAILED', '')}_TIMEOUT`,
      `"${result.command}" exceeded its ${options.timeoutMs}ms limit and was killed`,
      { retryable: true },
    );
  }
  if (result.signal !== null) {
    throw new StageError(
      options.failureCode,
      `"${result.command}" was killed by ${result.signal}`,
      { retryable: true },
    );
  }
  if (result.exitCode !== 0) {
    throw new StageError(
      options.failureCode,
      `"${result.command}" exited with code ${String(result.exitCode)}`,
    );
  }
  return result;
}

/**
 * `AppError` codes that describe the *host*, not the deployment.
 *
 * A worker without a working Docker socket, or without the base image pulled,
 * will fail every deployment it is given — but the next attempt may land on a
 * worker that has both, so these are worth re-queuing (Phase 8). Contrast a
 * refused archive entry or an over-size upload: those describe the project and
 * would be refused identically everywhere.
 */
const RETRYABLE_APP_ERROR_CODES = new Set([
  'DOCKER_UNAVAILABLE',
  'DOCKER_BASE_IMAGE_MISSING',
  'STORAGE_UNAVAILABLE',
  'OBJECT_STORE_UNAVAILABLE',
]);

/**
 * Gives every failure a stage code, a safe message, and a retry verdict.
 *
 * The extractor and the sandbox throw `AppError`s (they are shared with the
 * API, where the same checks answer HTTP requests), so their codes are reused
 * verbatim rather than flattened into a generic pipeline error.
 *
 * `PIPELINE_ERROR` — anything that reached here unclassified — is marked
 * **retryable**. An error nobody predicted is more likely to be a transient
 * one (a database blip, a socket that went away mid-stream) than a
 * deterministic property of the project, and the asymmetry matters: a wasted
 * retry costs one build, a wrongly-dead-lettered deployment costs a human.
 */
function normalizeError(err: unknown): Error {
  if (err instanceof StageError) return err;
  if (err instanceof StepAbortedError) {
    return new StageError('BUILD_ABORTED', err.message, { retryable: true });
  }
  if (isAppError(err)) {
    return new StageError(err.code, scrubPaths(err.message), {
      retryable: RETRYABLE_APP_ERROR_CODES.has(err.code),
    });
  }
  // An unexpected error's message is whatever the failing library wrote, which
  // routinely includes an absolute path (`ENOENT ... '/home/.../builds/…'`).
  // That message goes into `deployments.error_message` and straight out of the
  // API, so it is scrubbed here rather than trusted.
  if (err instanceof Error) {
    return new StageError('PIPELINE_ERROR', scrubPaths(err.message), { retryable: true });
  }
  return new StageError('PIPELINE_ERROR', scrubPaths(String(err)), { retryable: true });
}
