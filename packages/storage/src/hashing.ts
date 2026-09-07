import { createHash, type Hash } from 'node:crypto';
import { Transform, type TransformCallback, Writable } from 'node:stream';
import { badRequest } from '@forge/shared';

/**
 * A `Transform` that computes sha256 and enforces a byte cap in the same pass
 * over data we were already streaming.
 *
 * The point is that neither the hash nor the size costs an extra read: an
 * upload is hashed while it is being written, and an oversized one fails on the
 * chunk that crosses the limit instead of after the whole body has landed.
 */
export type HashingCounterOptions = {
  /** Fail once more than this many bytes have passed through. */
  limitBytes?: number;
  /** Error thrown when the cap is exceeded; a 400 by default. */
  limitError?: () => Error;
};

export class HashingCounter extends Transform {
  readonly #hash: Hash = createHash('sha256');
  readonly #limitBytes: number;
  readonly #limitError: () => Error;
  #bytes = 0;
  #digest: string | null = null;

  constructor(options: HashingCounterOptions = {}) {
    super();
    this.#limitBytes = options.limitBytes ?? Number.POSITIVE_INFINITY;
    this.#limitError =
      options.limitError ??
      (() =>
        badRequest(
          'OBJECT_TOO_LARGE',
          `Stream exceeded the maximum allowed size of ${this.#limitBytes} bytes`,
        ));
  }

  /** Bytes seen so far; final once the stream has ended. */
  get bytes(): number {
    return this.#bytes;
  }

  /**
   * Hex sha256 of everything that passed through. Only readable after the
   * stream has flushed — reading it early is a bug, not an empty string.
   */
  get digest(): string {
    if (this.#digest === null) {
      throw new Error('HashingCounter.digest read before the stream finished');
    }
    return this.#digest;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#bytes += chunk.length;
    if (this.#bytes > this.#limitBytes) {
      // Failing here means `pipeline()` tears down the write side too, so the
      // staged temp file is removed and no object is committed.
      callback(this.#limitError());
      return;
    }
    this.#hash.update(chunk);
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    this.#digest = this.#hash.digest('hex');
    callback();
  }
}

/**
 * Sink for a hash-only pass: `pipeline()` needs something to consume the
 * counter's output when we only want the digest, not a copy of the bytes.
 */
export function devNull(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}
