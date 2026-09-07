import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import { Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env, type Logger } from '@forge/config';
import { fileRepo, type DeploymentRow, type FileRow } from '@forge/db';
import { logKey, type LocalObjectStore, type StagedWrite } from '@forge/storage';
import {
  BUILD_LOG_INSERT_BATCH,
  BUILD_LOG_QUEUE_LINES,
  createRedactor,
  type LogStream,
  type RedactionRule,
} from '@forge/shared';
import { logLines, type PendingLogLine } from '../services/deployment-state.js';
import { LineSplitter } from './line-splitter.js';

/**
 * Where every line of a build's output goes.
 *
 * Two destinations, on purpose (ROADMAP Phase 6: "dual-write to log file +
 * `deployment_events`"):
 *
 *  - **The log object** — the complete record. Written incrementally into the
 *    object store's staged temp file and committed at the end, so it exists as
 *    a `files` row the dashboard can download even when the build failed.
 *  - **`deployment_events` + Redis** — the *replayable tail*. Bounded, because
 *    a row per line of a big `npm install` is a lot of rows and a socket frame
 *    each. Past the cap the log object keeps going and one notice says so.
 *
 * Backpressure is the reason this is a `Writable` rather than a method you
 * call. `child.stdout → LineSplitter → sink` is one pipeline, so when Postgres,
 * Redis or the disk is slow, the *child process* is throttled instead of the
 * worker's heap growing. Batching falls out of the same mechanism: while lines
 * are queued Node delivers them through `_writev`, which becomes one multi-row
 * insert (CLAUDE.md §4).
 */

export type LogSinkOptions = {
  store: LocalObjectStore;
  deployment: DeploymentRow;
  /**
   * Substrings to mask before a line is written anywhere — secret values, and
   * the host paths build tools like to print. See `createRedactor`.
   */
  redactions: Iterable<RedactionRule>;
  log: Logger;
};

export class LogSink {
  #row: DeploymentRow;
  readonly #log: Logger;
  readonly #redact: (line: string) => string;
  readonly #hash = createHash('sha256');

  #staged: StagedWrite | null = null;
  #file: WriteStream | null = null;

  #bytesWritten = 0;
  #eventsWritten = 0;
  #linesSeen = 0;
  #byteCapHit = false;
  #eventCapHit = false;
  #closed = false;

  private constructor(options: LogSinkOptions) {
    this.#row = options.deployment;
    this.#log = options.log;
    this.#redact = createRedactor(options.redactions);
  }

  /** Opens the staged log object. Nothing is committed until `close()`. */
  static async open(options: LogSinkOptions): Promise<LogSink> {
    const sink = new LogSink(options);
    const key = logKey(
      options.deployment.org_id,
      options.deployment.project_id,
      `${options.deployment.id}-${options.deployment.attempt}.log`,
    );
    sink.#staged = await options.store.beginStagedWrite(key);
    sink.#file = createWriteStream(sink.#staged.tempPath, { flags: 'wx' });
    // The stream is consumed through `write()` below rather than by a pipe, so
    // its errors have no other listener; without this a slow-disk EIO would be
    // an unhandled 'error' event and take the worker down.
    sink.#file.on('error', (err) => {
      options.log.error({ err }, 'build log file write failed');
    });
    return sink;
  }

  /** The pipeline advances; later lines are recorded under the new status. */
  setRow(row: DeploymentRow): void {
    this.#row = row;
  }

  get linesSeen(): number {
    return this.#linesSeen;
  }

  get truncated(): boolean {
    return this.#byteCapHit || this.#eventCapHit;
  }

  /**
   * A `Writable` accepting decoded lines for one stream.
   *
   * `highWaterMark` is in lines (objectMode), so it is exactly the queue depth
   * at which the child gets throttled.
   */
  writableFor(stream: LogStream): Writable {
    // Arrow functions rather than method shorthand: `this` has to stay the
    // sink, and a private field is only reachable from inside the class.
    const take = (lines: string[], callback: (err?: Error | null) => void): void => {
      this.#consume(stream, lines).then(
        () => callback(),
        (err: unknown) => callback(err instanceof Error ? err : new Error(String(err))),
      );
    };

    return new Writable({
      objectMode: true,
      highWaterMark: BUILD_LOG_QUEUE_LINES,
      write: (chunk: string, _encoding, callback) => take([String(chunk)], callback),
      writev: (chunks, callback) =>
        take(
          chunks.map((entry) => String(entry.chunk)),
          callback,
        ),
    });
  }

  /**
   * Pipes one process stream through the splitter into this sink.
   *
   * Returns the number of lines it carried, which is what the step summary
   * reports. `pipeline()` (not `.pipe()`) so a failure anywhere in the chain
   * tears the whole chain down instead of leaking a half-open stream.
   */
  async consumeStream(stream: LogStream, source: Readable): Promise<number> {
    const before = this.#linesSeen;
    await pipeline(source, new LineSplitter(), this.writableFor(stream));
    return this.#linesSeen - before;
  }

  /** A line the pipeline itself produced (stage descriptions, step summaries). */
  async system(message: string): Promise<void> {
    await this.#consume('system', [message]);
  }

  /**
   * One line the pipeline produced *on behalf of* a stream.
   *
   * The Docker Engine's build and pull output arrives as JSON records rather
   * than as a byte stream, so it cannot go through `consumeStream`; it is
   * decoded and handed over a line at a time, tagged `stdout`/`stderr` so the
   * dashboard colours it exactly like the `npm` output above it.
   */
  async line(stream: LogStream, message: string): Promise<void> {
    await this.#consume(stream, [message]);
  }

  async #consume(stream: LogStream, rawLines: string[]): Promise<void> {
    if (this.#closed) return;

    const lines: PendingLogLine[] = [];
    for (const raw of rawLines) {
      this.#linesSeen += 1;
      // Redact before *anything* is written: the log object is as plaintext as
      // the database, and a secret must not reach either (CLAUDE.md §8).
      const message = this.#redact(raw);
      if (this.#writeToFile(stream, message)) lines.push({ stream, message });
    }

    await this.#persist(lines);
    await this.#drainFile();
  }

  /**
   * Waits for the log file to catch up, if it is still behind.
   *
   * Normally `#persist` is the slow step and paces the producer for us — a
   * Postgres insert plus three Redis publishes dwarfs a buffered disk write.
   * But once the event cap is reached `#persist` returns immediately, and then
   * nothing would throttle a build writing megabytes a second: the write
   * stream's buffer would grow without bound in the worker's heap. So the
   * stream's own backpressure signal is honoured here.
   *
   * The condition is read from the stream (`writableNeedDrain`) rather than
   * latched when `write()` returned false. Latching deadlocks: the stream can
   * drain *while* we are awaiting the database, and then awaiting `'drain'`
   * waits for a second one that may never come — which stalls the child's
   * stdout and hangs the whole deployment. `writableNeedDrain` is true exactly
   * when a `'drain'` is still pending.
   */
  async #drainFile(): Promise<void> {
    const file = this.#file;
    if (!file || !file.writableNeedDrain) return;
    // A stream that has errored never drains; the error is already logged by
    // the handler installed in `open()`.
    await once(file, 'drain').catch(() => undefined);
  }

  /** Appends to the log object. Returns false once the byte cap is reached. */
  #writeToFile(stream: LogStream, message: string): boolean {
    if (this.#byteCapHit) return false;

    const record = `${new Date().toISOString()} ${stream.padEnd(6)} ${message}\n`;
    const buffer = Buffer.from(record, 'utf8');

    if (this.#bytesWritten + buffer.length > env.BUILD_MAX_LOG_BYTES) {
      this.#byteCapHit = true;
      const notice = Buffer.from(
        `${new Date().toISOString()} system [log truncated: reached the ${env.BUILD_MAX_LOG_BYTES}-byte limit after ${this.#linesSeen} lines]\n`,
        'utf8',
      );
      this.#bytesWritten += notice.length;
      this.#hash.update(notice);
      this.#file?.write(notice);
      this.#log.warn(
        { deploymentId: this.#row.id, bytes: this.#bytesWritten },
        'build log hit its byte cap',
      );
      return false;
    }

    this.#bytesWritten += buffer.length;
    this.#hash.update(buffer);
    // The return value is not latched: `#drainFile()` asks the stream itself
    // after the batch, which is the only way to avoid waiting on a `'drain'`
    // that has already been emitted.
    this.#file?.write(buffer);
    return true;
  }

  /** Persists + publishes a batch, honouring the event cap. */
  async #persist(lines: PendingLogLine[]): Promise<void> {
    if (lines.length === 0) return;

    if (this.#eventCapHit) return;

    const remaining = env.BUILD_MAX_LOG_EVENTS - this.#eventsWritten;
    if (remaining <= 0) {
      await this.#noteEventCap();
      return;
    }

    const accepted = lines.slice(0, remaining);
    for (let index = 0; index < accepted.length; index += BUILD_LOG_INSERT_BATCH) {
      const chunk = accepted.slice(index, index + BUILD_LOG_INSERT_BATCH);
      this.#eventsWritten += await logLines(this.#row, chunk);
    }

    if (accepted.length < lines.length) await this.#noteEventCap();
  }

  /** One line, once, explaining why the streamed timeline stops here. */
  async #noteEventCap(): Promise<void> {
    if (this.#eventCapHit) return;
    this.#eventCapHit = true;
    this.#log.warn(
      { deploymentId: this.#row.id, events: this.#eventsWritten },
      'build log hit its event cap; streaming only to the log object from here',
    );
    await logLines(this.#row, [
      {
        stream: 'system',
        message: `[streamed log truncated after ${this.#eventsWritten} lines — the complete build log is stored and downloadable]`,
      },
    ]).catch(() => undefined);
  }

  /**
   * Flushes, commits the log object and indexes it as a `files` row.
   *
   * Called for a failed build too: the log of a failure is the whole point of
   * having one. Never throws — losing the log must not turn a successful
   * deployment into a failed one, so a problem here is logged and reported as
   * `null`.
   */
  async close(): Promise<FileRow | null> {
    if (this.#closed) return null;
    this.#closed = true;

    const staged = this.#staged;
    const file = this.#file;
    this.#staged = null;
    this.#file = null;
    if (!staged || !file) return null;

    try {
      file.end();
      await once(file, 'finish');

      const committed = await staged.commit();
      return await fileRepo.insertFile({
        projectId: this.#row.project_id,
        deploymentId: this.#row.id,
        kind: 'log',
        storagePath: committed.key,
        sizeBytes: committed.sizeBytes,
        checksum: this.#hash.digest('hex'),
        contentType: 'text/plain; charset=utf-8',
        originalName: `build-${this.#row.id.slice(0, 8)}-attempt-${this.#row.attempt}.log`,
      });
    } catch (err) {
      this.#log.error({ err, deploymentId: this.#row.id }, 'could not store the build log');
      await staged.abort();
      return null;
    }
  }
}
