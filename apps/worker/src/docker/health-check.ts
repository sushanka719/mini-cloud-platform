import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { env, type Logger } from '@forge/config';

/**
 * The health check: poll the app's own HTTP endpoint until it answers 2xx.
 *
 * Deliberately *our* check rather than a Docker `HEALTHCHECK`. A Dockerfile
 * healthcheck runs inside the container, so it proves the process is up but not
 * that the port mapping works, and its result arrives asynchronously through
 * `inspect` polling anyway. Going through the published host port tests the
 * whole path a user's browser will take — which is what "live" is supposed to
 * mean.
 *
 * `node:http` rather than `fetch`: a per-attempt timeout that actually closes
 * the socket is one option here, and the health path is not a URL a user
 * supplies — it is validated to start with `/` at project-write time.
 */

export type HealthProbe = {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
};

/** One request. Never throws: a refused connection is data, not an exception. */
export async function probeHealth(
  hostPort: number,
  healthPath: string,
  timeoutMs: number,
): Promise<HealthProbe> {
  const startedAt = Date.now();

  return new Promise<HealthProbe>((resolve) => {
    const settle = (probe: Omit<HealthProbe, 'durationMs'>) => {
      resolve({ ...probe, durationMs: Date.now() - startedAt });
    };

    const req = request(
      {
        host: env.DOCKER_HOST_IP,
        port: hostPort,
        path: healthPath,
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'user-agent': 'forgecloud-health-check', connection: 'close' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // The body is irrelevant, but it has to be drained or the socket stays
        // open and the connection leaks until the timeout fires.
        res.resume();
        res.on('end', () => {
          settle({
            ok: status >= 200 && status < 300,
            statusCode: status,
            error: status >= 200 && status < 300 ? null : `HTTP ${String(status)}`,
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      settle({ ok: false, statusCode: null, error: `no response within ${String(timeoutMs)}ms` });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      // ECONNREFUSED while the app is still binding its port is the *expected*
      // state for the first second or two, not a failure.
      settle({ ok: false, statusCode: null, error: err.code ?? err.message });
    });
    req.end();
  });
}

export type HealthCheckResult = {
  ok: boolean;
  attempts: number;
  durationMs: number;
  /** The last probe's outcome — what to report when it never went healthy. */
  lastError: string | null;
  statusCode: number | null;
  /**
   * True when the worker's shutdown ended it rather than the app failing.
   * Reported separately because the two call for different codes: a
   * shutdown-aborted deployment is retryable on another worker, an unhealthy
   * app is not.
   */
  aborted: boolean;
};

export type HealthCheckOptions = {
  hostPort: number;
  healthPath: string;
  /** Total budget, from the project's `health_timeout_ms`. */
  timeoutMs: number;
  log: Logger;
  /** Called between attempts; returning a string aborts with that reason. */
  precondition?: () => Promise<string | null>;
  /** Reports each attempt, so the log shows the app coming up. */
  onAttempt?: (attempt: number, probe: HealthProbe) => Promise<void>;
  signal: AbortSignal;
};

/**
 * Polls until 2xx or the budget is spent.
 *
 * The `precondition` hook is what makes a crashed app fail in two seconds
 * instead of thirty: the pipeline passes a check on the container's state, so a
 * process that exited immediately is reported as "the container exited with
 * code 1" rather than as a health-check timeout, which would send the reader
 * looking in the wrong place.
 */
export async function waitForHealthy(options: HealthCheckOptions): Promise<HealthCheckResult> {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  let attempts = 0;
  let lastError: string | null = null;
  let statusCode: number | null = null;

  for (;;) {
    if (options.signal.aborted) {
      return {
        ok: false,
        attempts,
        durationMs: Date.now() - startedAt,
        lastError: 'the worker is shutting down',
        statusCode,
        aborted: true,
      };
    }

    if (options.precondition) {
      const problem = await options.precondition();
      if (problem !== null) {
        return {
          ok: false,
          attempts,
          durationMs: Date.now() - startedAt,
          lastError: problem,
          statusCode,
          aborted: false,
        };
      }
    }

    attempts += 1;
    // Never let one attempt outlive the overall budget.
    const remaining = deadline - Date.now();
    const probe = await probeHealth(
      options.hostPort,
      options.healthPath,
      Math.max(250, Math.min(env.DOCKER_HEALTH_REQUEST_TIMEOUT_MS, remaining)),
    );
    statusCode = probe.statusCode;
    lastError = probe.error;
    await options.onAttempt?.(attempts, probe);

    if (probe.ok) {
      return {
        ok: true,
        attempts,
        durationMs: Date.now() - startedAt,
        lastError: null,
        statusCode,
        aborted: false,
      };
    }
    if (Date.now() + env.DOCKER_HEALTH_INTERVAL_MS >= deadline) {
      return {
        ok: false,
        attempts,
        durationMs: Date.now() - startedAt,
        lastError,
        statusCode,
        aborted: false,
      };
    }
    await delay(env.DOCKER_HEALTH_INTERVAL_MS);
  }
}
