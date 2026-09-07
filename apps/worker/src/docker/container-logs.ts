import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Container } from 'dockerode';
import type { Logger } from '@forge/config';
import { LineSplitter } from '../build/line-splitter.js';
import type { LogSink } from '../build/log-sink.js';
import { demuxDockerStream } from './log-demux.js';
import { dockerUnavailable } from './client.js';

/**
 * Following a container's output into the deployment's log.
 *
 * The chain is: Engine socket → `demuxDockerStream` (un-interleave the two
 * streams) → `LineSplitter` (bytes to lines) → `LineBudget` (stop before the
 * timeline drowns) → the same `LogSink` the build wrote to. Which is the point:
 * the container's first words land in the browser through exactly the machinery
 * Phase 6 built for `npm install`, tagged `stdout`/`stderr` and coloured the
 * same way.
 */

/**
 * A line allowance shared by both streams.
 *
 * Shared rather than one per stream, because "the app printed 2 000 lines" is
 * one fact whichever descriptor it used, and an app that logs its startup to
 * stderr should not get double the budget.
 */
class LineBudget {
  #used = 0;
  #exhausted = false;

  constructor(private readonly max: number) {}

  get exhausted(): boolean {
    return this.#exhausted;
  }

  get used(): number {
    return this.#used;
  }

  /** Returns false once the budget is gone. */
  take(): boolean {
    if (this.#exhausted) return false;
    this.#used += 1;
    if (this.#used > this.max) {
      this.#exhausted = true;
      return false;
    }
    return true;
  }
}

/** Passes lines through until the shared budget runs out, then ends. */
class BudgetedLines extends Transform {
  constructor(private readonly budget: LineBudget) {
    super({ objectMode: true });
  }
  override _transform(line: string, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.budget.take()) {
      callback(null, line);
      return;
    }
    // Ending rather than erroring: the budget being spent is a normal outcome,
    // and `pipeline` treats an error as a failed deployment stage.
    this.push(null);
    callback();
  }
}

export type ContainerLogFollower = {
  /** Resolves when the stream ended, was stopped, or spent its budget. */
  done: Promise<void>;
  /** Stops following. Idempotent; safe to call from a `finally`. */
  stop: () => void;
  /** Lines forwarded so far. */
  lines: () => number;
  truncated: () => boolean;
};

/**
 * Starts following a container's logs.
 *
 * Nothing here is awaited by the caller until it wants to stop: the health
 * check runs *while* this streams, which is the whole reason a crash-looping
 * app shows its stack trace in the browser instead of only a
 * `HEALTH_CHECK_FAILED` at the end.
 */
export async function followContainerLogs(options: {
  container: Container;
  sink: LogSink;
  log: Logger;
  maxLines: number;
}): Promise<ContainerLogFollower> {
  const budget = new LineBudget(options.maxLines);

  let raw: Readable;
  try {
    raw = (await options.container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      // `tail` is left at its default ("all"), so the stream starts at the
      // beginning of this container's life: it may have printed — and crashed —
      // before we got here, and that output is the whole diagnosis.
    })) as unknown as Readable;
  } catch (err) {
    throw dockerUnavailable(err);
  }

  const demuxed = demuxDockerStream(raw);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // Destroying the Engine socket ends the demuxer, which ends both branches.
    raw.destroy();
  };

  const branch = (stream: 'stdout' | 'stderr', source: Readable) =>
    pipeline(source, new LineSplitter(), new BudgetedLines(budget), options.sink.writableFor(stream))
      .catch((err: unknown) => {
        // Two expected teardowns, neither of them a failure: `stop()` destroys
        // the Engine socket, and a spent budget ends the branch from the
        // middle — both surface here as a premature close.
        if (stopped || budget.exhausted) return;
        options.log.warn({ err, stream }, 'container log stream ended with an error');
      });

  const done = Promise.all([branch('stdout', demuxed.stdout), branch('stderr', demuxed.stderr)])
    .then(() => undefined)
    .finally(stop);

  return {
    done,
    stop,
    lines: () => budget.used,
    truncated: () => budget.exhausted,
  };
}
