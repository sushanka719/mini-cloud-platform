import { createReadStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { env, type Logger } from '@forge/config';
import { AppError, serviceUnavailable } from '@forge/shared';
import { LineSplitter } from '../build/line-splitter.js';
import { StepAbortedError } from '../build/spawn-step.js';
import type { LogSink } from '../build/log-sink.js';
import { dockerUnavailable, getDocker, isDockerNotFound } from './client.js';
import { FORGE_DOCKERFILE } from './context.js';

/**
 * Building the deployment image.
 *
 * The image *is* the artifact: it is what a container is created from now and
 * what Phase 8's rollback re-creates a container from later, which is why the
 * tag carries the deployment id and the attempt and why old ones are pruned by
 * count rather than on sight.
 *
 * The Engine answers `POST /build` with a stream of newline-delimited JSON
 * progress objects. dockerode ships `followProgress` for this, which buffers
 * the whole thing and hands it over at the end — the opposite of what a live
 * build log needs. So the stream is read as it arrives, through the same
 * `LineSplitter` the child-process logs use (CLAUDE.md §4).
 */

/** One record in the Engine's build progress stream. */
type BuildEvent = {
  stream?: string;
  status?: string;
  error?: string;
  errorDetail?: { message?: string };
  aux?: { ID?: string };
};

export class ImageBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageBuildError';
  }
}

/**
 * Makes sure the runtime base image is present.
 *
 * Pulling is off by default: a demo on a train should fail with "the base image
 * is not present locally" rather than hang for two minutes on a registry it
 * cannot reach.
 */
export async function ensureBaseImage(sink: LogSink, log: Logger): Promise<void> {
  const docker = getDocker();
  const reference = env.DOCKER_BASE_IMAGE;

  try {
    const info = (await docker.getImage(reference).inspect()) as { Id: string; Size?: number };
    await sink.system(
      `Base image ${reference} present locally (${info.Id.slice(7, 19)}, ${String(info.Size ?? 0)} bytes)`,
    );
    return;
  } catch (err) {
    if (!isDockerNotFound(err)) throw dockerUnavailable(err);
  }

  if (!env.DOCKER_PULL_BASE_IMAGE) {
    throw serviceUnavailable(
      'DOCKER_BASE_IMAGE_MISSING',
      `The base image "${reference}" is not present on this Docker host. Pull it once (docker pull ${reference}) or set DOCKER_PULL_BASE_IMAGE=true`,
    );
  }

  await sink.system(`Base image ${reference} is missing; pulling it`);
  const stream = (await docker.pull(reference)) as Readable;
  await readEngineStream(stream, sink, log, 'pull');
  await sink.system(`Pulled ${reference}`);
}

/**
 * Looks up an image by tag on this Docker host, without building anything.
 *
 * The rollback path's first question (Phase 8): the target deployment recorded
 * an `image_tag`, but `pruneProjectImages` keeps only `DOCKER_KEEP_IMAGES` per
 * project, so the tag outliving the image is normal rather than exceptional.
 * `null` means "gone", which is an answer the caller acts on (rebuild from the
 * stored artifact) rather than an error.
 */
export async function findLocalImage(
  tag: string,
): Promise<{ imageId: string; sizeBytes: number } | null> {
  try {
    const info = (await getDocker().getImage(tag).inspect()) as { Id: string; Size?: number };
    return { imageId: info.Id, sizeBytes: info.Size ?? 0 };
  } catch (err) {
    if (isDockerNotFound(err)) return null;
    throw dockerUnavailable(err);
  }
}

export type BuildImageOptions = {
  tag: string;
  /** Absolute path of the context tar produced by `createBuildContext`. */
  contextPath: string;
  sink: LogSink;
  log: Logger;
  timeoutMs: number;
  signal: AbortSignal;
};

export type BuiltImage = {
  tag: string;
  imageId: string;
  sizeBytes: number;
  durationMs: number;
};

/**
 * Runs `docker build` and streams its output into the deployment log.
 *
 * Two honest limits, both worth knowing:
 *  - the build runs *in the daemon*, so a timeout abandons our stream rather
 *    than cancelling the work; the tag simply never appears;
 *  - `networkmode: none` is safe only because the generated Dockerfile has no
 *    `RUN` step. Install and build already happened on the host, under
 *    `spawn`; the image assembly is pure `COPY`.
 */
export async function buildDeploymentImage(options: BuildImageOptions): Promise<BuiltImage> {
  const docker = getDocker();
  const startedAt = Date.now();

  const context = createReadStream(options.contextPath);
  let stream: Readable;
  try {
    stream = (await docker.buildImage(context, {
      t: options.tag,
      dockerfile: FORGE_DOCKERFILE,
      // Remove intermediate containers even when the build fails, so a broken
      // build cannot leave anything behind for the sweeper to find.
      rm: true,
      forcerm: true,
      // Never consult a registry: the base image was resolved above, and a
      // silent pull here would make an offline build hang.
      pull: false,
      networkmode: 'none',
      // Labels are `LABEL` instructions in the generated Dockerfile rather
      // than this endpoint's `labels` parameter — see `writeDockerfile`.
    })) as unknown as Readable;
  } catch (err) {
    context.destroy();
    throw dockerUnavailable(err);
  }

  const timer = setTimeout(() => {
    stream.destroy(
      new ImageBuildError(`Image build exceeded its ${String(options.timeoutMs)}ms limit`),
    );
  }, options.timeoutMs);
  timer.unref();

  const onAbort = () => {
    stream.destroy(new ImageBuildError('Image build was stopped because the worker is shutting down'));
  };
  if (options.signal.aborted) {
    stream.destroy();
    clearTimeout(timer);
    throw new StepAbortedError('The image build was not started: the worker is shutting down');
  }
  options.signal.addEventListener('abort', onAbort, { once: true });

  let imageId: string | null = null;
  try {
    imageId = await readEngineStream(stream, options.sink, options.log, 'build');
  } catch (err) {
    // A shutdown and a broken build are different failures: one is retryable
    // on another worker, the other will fail there too.
    if (options.signal.aborted) {
      throw new StepAbortedError('The image build was stopped because the worker is shutting down');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
  }

  // `aux.ID` is only sent by newer daemons; falling back to inspecting the tag
  // we just created is both a resolution and a confirmation that it exists.
  const inspected = (await docker.getImage(options.tag).inspect()) as {
    Id: string;
    Size?: number;
  };

  return {
    tag: options.tag,
    imageId: imageId ?? inspected.Id,
    sizeBytes: inspected.Size ?? 0,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Reads one of the Engine's NDJSON progress streams into the log sink.
 *
 * Returns the image id when the stream announced one. An `error` record is the
 * daemon reporting a failed build over a stream that then ends *successfully* —
 * so it has to be captured and thrown, or a broken build looks like a clean one.
 */
async function readEngineStream(
  stream: Readable,
  sink: LogSink,
  log: Logger,
  what: 'build' | 'pull',
): Promise<string | null> {
  let imageId: string | null = null;
  let failure: string | null = null;
  /** Progress records repeat the same status per layer; only changes are logged. */
  let lastStatus = '';

  const consume = new Writable({
    objectMode: true,
    write(line: string, _encoding, callback) {
      void (async () => {
        const text = line.trim();
        if (text.length === 0) {
          callback();
          return;
        }

        let event: BuildEvent;
        try {
          event = JSON.parse(text) as BuildEvent;
        } catch {
          // Not JSON: an older daemon, or a proxy in the way. It is still
          // output, so it is logged rather than dropped.
          await sink.line('stdout', text);
          callback();
          return;
        }

        try {
          if (event.error !== undefined || event.errorDetail?.message !== undefined) {
            failure = event.errorDetail?.message ?? event.error ?? 'unknown build error';
            await sink.line('stderr', failure);
          } else if (event.stream !== undefined) {
            // `stream` records already carry their own newlines.
            const body = event.stream.replace(/\n+$/, '');
            if (body.length > 0) await sink.line('stdout', body);
          } else if (event.status !== undefined && event.status !== lastStatus) {
            lastStatus = event.status;
            await sink.line('stdout', event.status);
          }
          if (event.aux?.ID !== undefined) imageId = event.aux.ID;
          callback();
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    },
  });

  try {
    await pipeline(stream, new LineSplitter(), consume);
  } catch (err) {
    if (err instanceof ImageBuildError) throw err;
    if (err instanceof AppError) throw err;
    log.warn({ err, what }, 'docker engine stream failed');
    throw new ImageBuildError(
      `Reading the docker ${what} output failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (failure !== null) throw new ImageBuildError(failure);
  return imageId;
}

/**
 * Removes a project's older images, keeping the newest `keep` of them.
 *
 * Run after a deployment goes live, not before: the image a rollback would need
 * is the *previous* one, so pruning has to happen once the new one is proven.
 * `keep` is therefore also the depth Phase 8's rollback can reach.
 */
export async function pruneProjectImages(
  repository: string,
  keep: number,
  log: Logger,
): Promise<number> {
  const docker = getDocker();
  let images: { Id: string; RepoTags?: string[] | null; Created: number }[];
  try {
    images = (await docker.listImages({
      filters: JSON.stringify({ reference: [repository] }),
    })) as { Id: string; RepoTags?: string[] | null; Created: number }[];
  } catch (err) {
    log.warn({ err, repository }, 'could not list images for pruning');
    return 0;
  }

  // Newest first. `Created` is a unix timestamp in seconds.
  const ordered = [...images].sort((a, b) => b.Created - a.Created);
  let removed = 0;

  for (const image of ordered.slice(keep)) {
    const tags = (image.RepoTags ?? []).filter((tag) => tag.startsWith(`${repository}:`));
    for (const tag of tags) {
      try {
        await docker.getImage(tag).remove();
        removed += 1;
      } catch (err) {
        // A tag still referenced by a running container cannot be removed, and
        // that is the correct outcome — the previous deployment may still be
        // serving. Pruning is housekeeping, never a failure.
        log.debug({ err, tag }, 'could not remove image');
      }
    }
  }

  if (removed > 0) log.info({ repository, removed, keep }, 'pruned old deployment images');
  return removed;
}
