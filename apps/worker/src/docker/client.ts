import Docker from 'dockerode';
import { env, type Logger } from '@forge/config';
import { serviceUnavailable } from '@forge/shared';

/**
 * The worker's handle on the Docker Engine API.
 *
 * One client per process. `dockerode` holds no persistent connection — every
 * call is an HTTP request over the socket — so there is nothing to pool and
 * nothing to close except the streams individual operations open, which their
 * own callers own.
 *
 * Docker lives here and only here: ARCHITECTURE §9 keeps it out of the API,
 * which is why stop/restart is a queued job rather than a route calling
 * `container.stop()`.
 */

let client: Docker | null = null;

export function getDocker(): Docker {
  if (client) return client;
  // DOCKER_HOST (a TCP daemon) takes precedence, because that is the variable
  // every other Docker tool honours and dockerode reads it from the
  // environment itself when given no explicit socket.
  client = process.env.DOCKER_HOST
    ? new Docker()
    : new Docker({ socketPath: env.DOCKER_SOCKET });
  return client;
}

export type DockerInfo = {
  version: string;
  apiVersion: string;
  os: string;
  arch: string;
  containers: number;
};

/**
 * Confirms the daemon is reachable.
 *
 * Called at boot to *log* rather than to exit: a worker with no Docker can
 * still clone, install and build, and failing the deployment at
 * `creating_container` with `DOCKER_UNAVAILABLE` is more useful than a worker
 * that refuses to start.
 */
export async function pingDocker(): Promise<DockerInfo> {
  const docker = getDocker();
  const [version, info] = await Promise.all([
    docker.version(),
    docker.info() as Promise<{ Containers?: number }>,
  ]);
  return {
    version: version.Version,
    apiVersion: version.ApiVersion,
    os: version.Os,
    arch: version.Arch,
    containers: info.Containers ?? 0,
  };
}

/** Logs Docker's availability at boot without making it a startup dependency. */
export async function reportDockerAvailability(log: Logger): Promise<boolean> {
  try {
    const info = await pingDocker();
    log.info(info, 'docker engine reachable');
    return true;
  } catch (err) {
    log.warn(
      { err, socket: env.DOCKER_SOCKET },
      'docker engine is NOT reachable — builds will run, deployments will fail at creating_container',
    );
    return false;
  }
}

/** Docker's own errors carry an HTTP status; 404 is "no such thing". */
export function isDockerNotFound(err: unknown): boolean {
  return (err as { statusCode?: number } | null)?.statusCode === 404;
}

/** 409 = conflict: already started, already stopped, name in use. */
export function isDockerConflict(err: unknown): boolean {
  return (err as { statusCode?: number } | null)?.statusCode === 409;
}

/**
 * Wraps a daemon-unreachable failure into something with a code.
 *
 * A dead socket surfaces as ECONNREFUSED/ENOENT from the HTTP layer, whose
 * message names the socket path — that is our host layout, so it is replaced
 * rather than forwarded (CLAUDE.md §8).
 */
export function dockerUnavailable(err: unknown): Error {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'EACCES') {
    return serviceUnavailable(
      'DOCKER_UNAVAILABLE',
      'The Docker daemon is not reachable from this worker',
      err,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
