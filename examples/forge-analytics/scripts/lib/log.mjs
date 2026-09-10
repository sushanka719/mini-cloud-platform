/**
 * Build output helpers.
 *
 * Deliberately line-oriented and ANSI-free. ForgeCloud's worker sets NO_COLOR=1
 * and splits the child's stdout on newlines before persisting each line into
 * `deployment_events` and publishing it to the browser, so a `\r`-animated
 * progress bar would arrive as one enormous unreadable line. Every update here
 * is therefore its own discrete line.
 */

const started = Date.now();

/** ms since the build began, as a fixed-width column so the log lines up. */
function elapsed() {
  return `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s`;
}

export function line(message = '') {
  process.stdout.write(`${elapsed()} │ ${message}\n`);
}

export function warn(message) {
  // stderr on purpose: the dashboard colours the two streams differently, and a
  // build with nothing on stderr never demonstrates that.
  process.stderr.write(`${elapsed()} ! ${message}\n`);
}

export function banner(index, total, title) {
  const label = `[${index}/${total}] ${title}`;
  process.stdout.write(`\n${elapsed()} ┌─ ${label} ${'─'.repeat(Math.max(0, 58 - label.length))}\n`);
}

export function done(title, ms, detail = '') {
  process.stdout.write(
    `${elapsed()} └─ ${title} finished in ${formatMs(ms)}${detail ? ` — ${detail}` : ''}\n`,
  );
}

/** A discrete progress line: `  ▍ generate  1,250,000/2,000,000  62%`. */
export function progress(label, current, total, note = '') {
  const percent = total === 0 ? 100 : Math.round((current / total) * 100);
  line(
    `  ${label.padEnd(12)} ${num(current).padStart(11)}/${num(total).padEnd(11)} ` +
      `${String(percent).padStart(3)}%${note ? `  ${note}` : ''}`,
  );
}

/** A two-column key/value line, for the summary blocks. */
export function field(key, value) {
  line(`  ${String(key).padEnd(22)} ${String(value)}`);
}

export function num(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : String(n);
}

export function formatMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 2 : 0)} ${units[unit]}`;
}

/** Wraps a stage so every one is timed and announced identically. */
export async function stage(index, total, title, fn) {
  banner(index, total, title);
  const t0 = Date.now();
  const detail = await fn();
  const ms = Date.now() - t0;
  done(title, ms, typeof detail === 'string' ? detail : '');
  return { title, ms };
}
