import type { ChildProcess } from 'node:child_process';

/**
 * Every build process this worker currently owns.
 *
 * A worker asked to shut down has to do something about children that may run
 * for minutes: `SHUTDOWN_TIMEOUT_MS` is ten seconds, so waiting is not an
 * option, and exiting without killing them leaves orphaned `npm` processes
 * holding the sandbox open — the sandbox we are about to delete.
 *
 * So shutdown aborts them. The step throws, the deployment is recorded as
 * failed with a reason that says why, and the queue's retry (Phase 8) or
 * another replica (Phase 10) picks it up. A visible failure with a stated cause
 * beats a process tree that outlives its parent.
 */

const children = new Set<ChildProcess>();
const aborters = new Set<AbortController>();

/** Tracks a running child; the returned function untracks it. */
export function registerChild(child: ChildProcess): () => void {
  children.add(child);
  return () => children.delete(child);
}

/** An abort signal for one deployment's steps, released when it finishes. */
export function createBuildAbort(): { controller: AbortController; release: () => void } {
  const controller = new AbortController();
  aborters.add(controller);
  return { controller, release: () => aborters.delete(controller) };
}

export function activeBuildCount(): number {
  return children.size;
}

/**
 * Aborts every in-flight build and signals its process group.
 *
 * The abort is what lets the pipeline record a reason; the signal is what
 * guarantees nothing survives us. Both, in that order.
 */
export function abortAllBuilds(reason = 'worker is shutting down'): number {
  const count = children.size;
  for (const controller of aborters) controller.abort(new Error(reason));
  for (const child of children) {
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    }
  }
  return count;
}
