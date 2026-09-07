import { Transform, type TransformCallback } from 'node:stream';
import { MAX_LOG_LINE_LENGTH } from '@forge/shared';

/**
 * Turns a byte stream into lines.
 *
 * Hand-written on purpose (CLAUDE.md §4: log streaming stays visible). A child
 * process's stdout arrives in arbitrary chunks that have nothing to do with
 * line boundaries — one `read` can carry half a line, forty lines, or a line
 * split across a multi-byte UTF-8 character — so three things have to be right:
 *
 *  1. **Carry-over.** The tail of a chunk with no newline is held until the
 *     next one arrives, and emitted at `_flush` if the process exits without a
 *     final newline (which `npm` does, for its progress output).
 *  2. **Decoding across chunks.** `setEncoding('utf8')` on the Transform makes
 *     Node hold an incomplete multi-byte sequence for us, so a `─` split down
 *     the middle by the chunk boundary is not turned into two replacement
 *     characters.
 *  3. **Bounded memory.** A process that writes 500 MB with no newline (a
 *     minified bundle to stdout, a progress bar) must not grow the buffer
 *     forever. Past `MAX_LOG_LINE_LENGTH` the carry is cut and emitted as a
 *     truncated line, so the cap is enforced here rather than only at the
 *     database.
 *
 * `\r` handling: `\r\n` loses the `\r`, and a bare `\r` (progress bars redraw
 * with it) also ends a line — otherwise a five-minute `npm install` is one
 * enormous line.
 */
export class LineSplitter extends Transform {
  #carry = '';

  constructor() {
    // objectMode out: we emit strings, not bytes.
    super({ readableObjectMode: true, writableObjectMode: false });
    this.setEncoding('utf8');
  }

  override _transform(chunk: string, _encoding: BufferEncoding, callback: TransformCallback): void {
    // `setEncoding` means chunk is already a decoded string.
    let text = this.#carry + chunk;
    this.#carry = '';

    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char !== '\n' && char !== '\r') continue;
      this.push(text.slice(start, i));
      // Treat CRLF as one terminator.
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      start = i + 1;
    }

    text = text.slice(start);
    if (text.length > MAX_LOG_LINE_LENGTH) {
      // No newline in sight and already over the cap: emit what we have as a
      // line of its own rather than buffering the rest of the stream.
      this.push(text.slice(0, MAX_LOG_LINE_LENGTH));
      text = text.slice(MAX_LOG_LINE_LENGTH);
      // Anything still left is handled on the next pass through the loop above
      // (or the flush), so a 10 MB blob becomes 2 500 lines, not one.
      while (text.length > MAX_LOG_LINE_LENGTH) {
        this.push(text.slice(0, MAX_LOG_LINE_LENGTH));
        text = text.slice(MAX_LOG_LINE_LENGTH);
      }
    }
    this.#carry = text;
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (this.#carry.length > 0) {
      this.push(this.#carry);
      this.#carry = '';
    }
    callback();
  }
}
