/**
 * Constants and helpers for real build execution (Phase 6).
 *
 * Tuning knobs that are properties of the *protocol* between the worker, Redis
 * and the dashboard live here rather than in the environment, for the same
 * reason the WebSocket limits do: both ends have to agree on them, and a value
 * one process can change alone is not an agreement.
 */

/**
 * How many lines may queue in front of the log sink before Node applies
 * backpressure to the child process's stdout.
 *
 * This is the sink's `highWaterMark`, and it is also what makes batching
 * happen: while lines are queued, Node hands the sink the whole queue through
 * `_writev`, which becomes one multi-row insert. A quiet build writes one row
 * at a time; a noisy one batches — driven by real backpressure rather than by
 * a timer that would have to guess.
 */
export const BUILD_LOG_QUEUE_LINES = 64;

/** Upper bound on rows in a single `deployment_events` insert. */
export const BUILD_LOG_INSERT_BATCH = 200;

/** Marker prefix on the `system` lines the pipeline itself writes. */
export const BUILD_SYSTEM_PREFIX = '›';

/**
 * A secret shorter than this is not redacted from build output.
 *
 * Masking "1", "true" or "3000" would punch holes in every line that happens
 * to contain those characters, which destroys the log without protecting
 * anything — a 3-character secret is not a secret.
 */
export const MIN_REDACTABLE_SECRET_LENGTH = 4;

/** What a masked value is replaced with. */
export const SECRET_MASK = '«redacted»';

/** One substring to mask, and what to put in its place. */
export type RedactionRule = { value: string; mask: string };

/**
 * Builds a line rewriter that masks a fixed set of substrings.
 *
 * Two kinds of thing get masked in build output, for two reasons:
 *
 *  - **Secret values.** The output is untrusted *and* can echo what we
 *    injected — `npm config ls`, a `console.log(process.env)`, a stack trace
 *    carrying a connection string. Env vars are encrypted at rest precisely so
 *    they never sit in plaintext, and `deployment_events` is plaintext, so the
 *    last hop before persistence is where they are removed (CLAUDE.md §8).
 *  - **Host paths.** Build tools print absolute paths (`npm` names its debug
 *    log). Those describe the machine's layout, which is ours and not the
 *    project's, so the sandbox and storage roots are replaced with a label.
 *
 * Longest-first, so a value that contains another is masked whole.
 */
export function createRedactor(rules: Iterable<RedactionRule>): (line: string) => string {
  const targets = [...rules]
    .filter((rule) => rule.value.length > 0)
    .sort((a, b) => b.value.length - a.value.length);

  if (targets.length === 0) return (line) => line;

  return (line) => {
    let out = line;
    for (const rule of targets) {
      // split/join rather than a RegExp: the values are arbitrary strings and
      // escaping them for a pattern is a bug waiting to happen.
      if (out.includes(rule.value)) out = out.split(rule.value).join(rule.mask);
    }
    return out;
  };
}

/**
 * The secret half of the above: values shorter than
 * `MIN_REDACTABLE_SECRET_LENGTH` are left alone, because masking "3000" or
 * "true" punches holes in every line that happens to contain them.
 */
export function secretRedactionRules(values: Iterable<string>): RedactionRule[] {
  return [...new Set(values)]
    .filter((value) => value.length >= MIN_REDACTABLE_SECRET_LENGTH)
    .map((value) => ({ value, mask: SECRET_MASK }));
}

/** Convenience wrapper for the secrets-only case. */
export function createSecretRedactor(values: Iterable<string>): (line: string) => string {
  return createRedactor(secretRedactionRules(values));
}

/** Outcome of one `spawn`ed pipeline step. */
export type StepResult = {
  /** The command as it was echoed into the log. */
  command: string;
  /** null when the process was killed by a signal instead of exiting. */
  exitCode: number | null;
  /** Signal name (`SIGTERM`, `SIGKILL`), typed as a string because this
   *  package is also imported by the browser bundle and has no node types. */
  signal: string | null;
  durationMs: number;
  /** True when our own deadline (not the process) ended it. */
  timedOut: boolean;
  linesOut: number;
  linesErr: number;
};

/** A one-line summary of a step, for the build log and the pino log. */
export function describeStepResult(result: StepResult): string {
  const how = result.timedOut
    ? `timed out after ${result.durationMs}ms`
    : result.signal !== null
      ? `killed by ${result.signal}`
      : `exited ${String(result.exitCode)}`;
  return `${result.command} — ${how} (${result.durationMs}ms, ${result.linesOut + result.linesErr} lines)`;
}
