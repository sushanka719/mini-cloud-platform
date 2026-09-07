import { PassThrough, Writable, pipeline, type Readable } from 'node:stream';
import { once } from 'node:events';

/**
 * Demultiplexing a Docker log stream, by hand (CLAUDE.md §4: "manage the
 * container lifecycle, **log stream demux**, resource limits and cleanup
 * ourselves").
 *
 * When a container is created with `Tty: false` — which ours are, deliberately,
 * because a TTY would merge the two streams and lose the distinction the
 * dashboard colours by — the Engine does not hand back two sockets. It hands
 * back one, carrying both streams interleaved in 8-byte-framed records:
 *
 * ```
 *   byte 0     stream type: 0 stdin, 1 stdout, 2 stderr
 *   bytes 1-3  zero padding
 *   bytes 4-7  payload length, uint32 big-endian
 *   bytes 8..  payload
 * ```
 *
 * A frame's payload is *not* a line, and a line is *not* a frame: one frame can
 * hold several lines and one line can straddle several frames. So this only
 * un-interleaves the two streams; splitting into lines stays the job of
 * `LineSplitter`, which already knows how to carry a partial line across
 * chunks. Two problems, two transforms.
 *
 * Backpressure is preserved end to end: a payload that a target won't accept
 * parks this writable until the target drains, which parks the socket, which is
 * what stops a chatty container from growing the worker's heap.
 */

/** Docker's frame header. */
const HEADER_BYTES = 8;

/**
 * Sanity bound on a single frame's payload.
 *
 * The Engine writes frames far smaller than this. A header claiming more is
 * either not a Docker stream at all or a corrupted one, and buffering towards
 * it would be an unbounded allocation driven by bytes we did not write.
 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class DockerStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerStreamError';
  }
}

/**
 * Writes to a target, waiting for `drain` when it says it is full.
 *
 * The wait races `drain` against `close`, because the consumer can go away
 * *while* we are waiting for it — the health check finishing calls `stop()`,
 * which tears the whole chain down. Waiting on `drain` alone would then wait
 * for an event that can no longer be emitted, and the deployment would hang
 * one step short of `live`.
 */
async function writeTo(target: PassThrough, payload: Buffer): Promise<void> {
  if (target.write(payload)) return;
  if (target.destroyed || target.writableEnded) return;

  const stop = new AbortController();
  // Both branches get a catch handler before the race, so the losing one
  // rejecting on abort is not an unhandled rejection.
  const drained = once(target, 'drain', { signal: stop.signal }).catch(() => undefined);
  const closed = once(target, 'close', { signal: stop.signal }).catch(() => undefined);
  await Promise.race([drained, closed]);
  stop.abort();
}

export type DemuxedStreams = {
  stdout: Readable;
  stderr: Readable;
  /** Resolves when the source ended and both targets were closed. */
  done: Promise<void>;
};

/**
 * Splits one multiplexed Docker stream into two readables.
 *
 * The targets are `PassThrough`s rather than something cleverer because their
 * consumer is `LogSink.consumeStream()`, which wants a plain `Readable` and
 * supplies the backpressure signal we honour above.
 */
export function demuxDockerStream(source: Readable): DemuxedStreams {
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  /** Bytes received but not yet forming a complete frame. */
  let carry: Buffer = Buffer.alloc(0);

  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);

      void (async () => {
        try {
          // Drain as many complete frames as the carry now holds. A partial
          // frame at the end stays for the next chunk.
          while (carry.length >= HEADER_BYTES) {
            const type = carry[0];
            const length = carry.readUInt32BE(4);
            if (length > MAX_FRAME_BYTES) {
              throw new DockerStreamError(
                `Docker log frame claims ${String(length)} bytes, which is not a frame we wrote`,
              );
            }
            if (carry.length < HEADER_BYTES + length) break;

            const payload = carry.subarray(HEADER_BYTES, HEADER_BYTES + length);
            // `subarray` is a view onto `carry`, and `carry` is about to be
            // re-sliced — so the payload is copied before it is handed on.
            const owned = Buffer.from(payload);
            carry = carry.subarray(HEADER_BYTES + length);

            // 1 = stdout, 2 = stderr. Type 0 is stdin, which a log stream
            // never carries; anything else is not a frame type Docker defines,
            // and either way it is not output — dropped rather than guessed at.
            if (type === 1) await writeTo(stdout, owned);
            else if (type === 2) await writeTo(stderr, owned);
          }
          callback();
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    },
    final(callback) {
      // A truncated tail means the daemon closed mid-frame (container killed,
      // socket dropped). Whatever it was is incomplete, so it is reported and
      // not emitted as if it were output.
      if (carry.length > 0) {
        stderr.write(
          Buffer.from(
            `\n[log stream ended mid-frame, ${String(carry.length)} bytes discarded]\n`,
            'utf8',
          ),
        );
      }
      stdout.end();
      stderr.end();
      callback();
    },
    destroy(err, callback) {
      stdout.destroy(err ?? undefined);
      stderr.destroy(err ?? undefined);
      callback(err);
    },
  });

  /**
   * `pipeline`, not `source.pipe(sink)`.
   *
   * `.pipe()` only ends the destination when the source emits `end`. The
   * Engine socket does not: it is *destroyed* — by `stop()` once the health
   * check settles, or by the daemon dropping the connection — and a destroyed
   * source leaves a piped destination open forever. That is a real deadlock
   * and it cost this phase a debugging session: the health check passed, both
   * branch pipelines stayed unresolved, and the deployment sat in
   * `health_check` with a container serving happily behind it.
   *
   * `pipeline` propagates destruction in both directions, so tearing down
   * either end tears down the whole chain — which is why `destroy()` above
   * exists to pass that on to the two branches.
   */
  const done = new Promise<void>((resolve, reject) => {
    pipeline(source, sink, (err) => {
      // A premature close is how `stop()` works, not a failure.
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        reject(err);
        return;
      }
      resolve();
    });
  });

  return { stdout, stderr, done };
}
