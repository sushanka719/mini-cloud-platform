import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { env, type Logger } from '@forge/config';
import { parseCommand, type StepResult } from '@forge/shared';
import type { LogSink } from './log-sink.js';
import { registerChild } from './active-builds.js';

/**
 * Running one build command.
 *
 * This is the §4 learning goal in one file: `spawn` with `shell: false`, real
 * stream plumbing for stdout/stderr, a deadline, and a kill path that actually
 * kills.
 *
 * Three things are easy to get wrong and are handled explicitly:
 *
 *  1. **No shell, ever.** The command string is tokenised by us (`parseCommand`)
 *     and handed over as `(file, args)`. There is no interpretation step a
 *     `; rm -rf /` could survive into, which is the point of CLAUDE.md §8's
 *     first rule — not merely that we validate the input.
 *  2. **Kill the group, not the process.** `npm run build` is a parent that
 *     spawns the real compiler; SIGTERM to `npm` alone orphans the child, which
 *     keeps the pipe open and the deployment hanging forever. `detached: true`
 *     makes the child a process-group leader so `kill(-pid)` reaches the whole
 *     tree.
 *  3. **Wait for `close`, not `exit`.** `exit` fires when the process is gone;
 *     `close` fires when its stdio has been fully consumed. Resolving on `exit`
 *     races the last few hundred lines of output.
 */

export type RunStepOptions = {
  /** The command as configured on the project, e.g. `npm ci`. */
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  sink: LogSink;
  log: Logger;
  /** Aborts the step — used by graceful shutdown. */
  signal: AbortSignal;
};

export class StepAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepAbortedError';
  }
}

export async function runStep(options: RunStepOptions): Promise<StepResult> {
  const { file, args, display } = parseCommand(options.command);
  const startedAt = Date.now();

  // An already-aborted signal never fires its 'abort' event, so a step started
  // *after* shutdown began would otherwise run to completion — spawning fresh
  // work while the process is trying to leave.
  if (options.signal.aborted) {
    throw new StepAbortedError(`"${display}" was not started: the worker is shutting down`);
  }

  // stdin is 'ignore' (a build must never expect input), so the child is typed
  // as "no stdin, both output pipes".
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      // The three rules: no shell, own process group, pipes we control.
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    // A synchronous throw here means the arguments were unusable (e.g. a cwd
    // that vanished); ENOENT arrives as an 'error' event instead.
    throw new Error(`Could not start "${display}": ${err instanceof Error ? err.message : ''}`);
  }

  const pid = child.pid;
  const release = registerChild(child);
  options.log.debug({ pid, command: display, cwd: options.cwd }, 'build step started');

  let timedOut = false;
  let aborted = false;
  let killTimer: NodeJS.Timeout | null = null;

  /**
   * SIGTERM the group, then SIGKILL it if it is still there.
   *
   * Signalling a group whose leader has already exited throws ESRCH, which is
   * not an error — it means the thing we wanted dead already is.
   */
  const killGroup = (signal: NodeJS.Signals) => {
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  };

  // Idempotent: the timeout and an abort can both fire, and a second
  // escalation would replace (and so leak) the pending SIGKILL timer.
  const escalate = () => {
    if (killTimer) return;
    killGroup('SIGTERM');
    killTimer = setTimeout(() => {
      options.log.warn({ pid, command: display }, 'build step ignored SIGTERM; sending SIGKILL');
      killGroup('SIGKILL');
    }, env.BUILD_KILL_GRACE_MS);
    killTimer.unref();
  };

  const deadline = setTimeout(() => {
    timedOut = true;
    options.log.warn({ pid, command: display, timeoutMs: options.timeoutMs }, 'build step timed out');
    escalate();
  }, options.timeoutMs);
  deadline.unref();

  const onAbort = () => {
    aborted = true;
    escalate();
  };
  options.signal.addEventListener('abort', onAbort, { once: true });

  // A spawn failure (ENOENT) surfaces as an event, and the streams then end
  // without producing anything — so it has to be captured, not awaited.
  const spawnErrors: NodeJS.ErrnoException[] = [];
  child.on('error', (err) => {
    spawnErrors.push(err);
  });

  try {
    // Both streams are drained concurrently. Draining them in sequence would
    // deadlock: a process that fills the stderr pipe blocks until someone
    // reads it, and we would still be waiting on stdout.
    const [exit, linesOut, linesErr] = await Promise.all([
      waitForClose(child),
      options.sink.consumeStream('stdout', child.stdout),
      options.sink.consumeStream('stderr', child.stderr),
    ]);

    const spawnError = spawnErrors[0];
    if (spawnError) {
      const message =
        spawnError.code === 'ENOENT' ? `Command not found: "${file}"` : spawnError.message;
      throw new Error(`Could not run "${display}": ${message}`);
    }

    const { exitCode, signal } = exit;
    const result: StepResult = {
      command: display,
      exitCode,
      signal,
      durationMs: Date.now() - startedAt,
      timedOut,
      linesOut,
      linesErr,
    };

    if (aborted) {
      throw new StepAbortedError(
        `"${display}" was stopped because the worker is shutting down`,
      );
    }

    return result;
  } finally {
    clearTimeout(deadline);
    if (killTimer) clearTimeout(killTimer);
    options.signal.removeEventListener('abort', onAbort);
    // If we are leaving for any reason other than a clean exit, make sure the
    // group is not still running behind us.
    if (child.exitCode === null && child.signalCode === null) killGroup('SIGKILL');
    release();
  }
}

/**
 * Resolves when the child has exited *and* its stdio is fully consumed.
 *
 * `events.once` would do, but its return type is `any[]`, and the exit code
 * and signal are worth having named.
 */
function waitForClose(
  child: ChildProcessByStdio<null, Readable, Readable>,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ exitCode: code, signal }));
  });
}
