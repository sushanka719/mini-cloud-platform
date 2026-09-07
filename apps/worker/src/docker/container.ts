import type Docker from 'dockerode';
import type { Container } from 'dockerode';
import { env, type Logger } from '@forge/config';
import {
  FORGE_LABELS,
  FORGE_MANAGED,
  badRequest,
  containerNameFor,
  type ContainerStats,
} from '@forge/shared';
import { dockerUnavailable, getDocker, isDockerConflict, isDockerNotFound } from './client.js';

/**
 * The container lifecycle: create, start, inspect, stop, remove, sample.
 *
 * Everything here is a direct Engine API call rather than a `docker` CLI
 * invocation (CLAUDE.md §4, and ARCHITECTURE §8's table): the resource limits,
 * the port binding and the labels are structured fields we set deliberately,
 * not flags concatenated into a command line.
 */

/** `docker inspect`'s state, narrowed to what we act on. */
export type ContainerState = {
  id: string;
  name: string;
  status: string;
  running: boolean;
  exitCode: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  oomKilled: boolean;
  /** Host port the app's port is published on, once it is bound. */
  hostPort: number | null;
};

type InspectResult = {
  Id: string;
  Name: string;
  State: {
    Status: string;
    Running: boolean;
    ExitCode: number;
    Error: string;
    StartedAt: string;
    FinishedAt: string;
    OOMKilled: boolean;
  };
  NetworkSettings: {
    Ports: Record<string, { HostIp: string; HostPort: string }[] | null> | null;
  };
};

const ZERO_TIME = '0001-01-01T00:00:00Z';

function portKey(appPort: number): string {
  return `${String(appPort)}/tcp`;
}

function toState(inspect: InspectResult, appPort: number): ContainerState {
  const binding = inspect.NetworkSettings.Ports?.[portKey(appPort)]?.[0];
  const parsed = binding ? Number.parseInt(binding.HostPort, 10) : Number.NaN;
  return {
    id: inspect.Id,
    // Docker returns names with a leading slash.
    name: inspect.Name.replace(/^\//, ''),
    status: inspect.State.Status,
    running: inspect.State.Running,
    exitCode: inspect.State.Running ? null : inspect.State.ExitCode,
    error: inspect.State.Error.length > 0 ? inspect.State.Error : null,
    startedAt: inspect.State.StartedAt === ZERO_TIME ? null : inspect.State.StartedAt,
    finishedAt: inspect.State.FinishedAt === ZERO_TIME ? null : inspect.State.FinishedAt,
    oomKilled: inspect.State.OOMKilled,
    hostPort: Number.isFinite(parsed) ? parsed : null,
  };
}

/**
 * Creates the deployment network if it is not there yet.
 *
 * A dedicated user-defined bridge rather than Docker's default one, so a
 * deployed app is not on the same network as our Postgres and Redis containers
 * and cannot reach them by service name. `host` is refused outright — sharing
 * the host's network stack would give a deployment every port on this machine
 * (CLAUDE.md §8: "no host network by default").
 */
export async function ensureDeploymentNetwork(log: Logger): Promise<string> {
  const name = env.DOCKER_NETWORK;
  if (name === 'host') {
    throw badRequest(
      'DOCKER_HOST_NETWORK_REFUSED',
      'DOCKER_NETWORK=host would give every deployment the host network stack',
    );
  }
  // `none` and `bridge` are Docker's own predefined networks; they exist
  // already and must not be created.
  if (name === 'none' || name === 'bridge') return name;

  const docker = getDocker();
  try {
    await docker.getNetwork(name).inspect();
    return name;
  } catch (err) {
    if (!isDockerNotFound(err)) throw dockerUnavailable(err);
  }

  try {
    await docker.createNetwork({
      Name: name,
      Driver: 'bridge',
      CheckDuplicate: true,
      Labels: { [FORGE_LABELS.managed]: FORGE_MANAGED },
    });
    log.info({ network: name }, 'created the deployment network');
  } catch (err) {
    // Two workers booting at once both see it missing and both create it; the
    // loser gets a 409, which means the network now exists either way.
    if (!isDockerConflict(err)) throw dockerUnavailable(err);
  }
  return name;
}

export type CreateContainerInput = {
  deploymentId: string;
  projectId: string;
  orgId: string;
  attempt: number;
  imageTag: string;
  appPort: number;
  /** Runtime environment, as `KEY=value`. Never baked into the image. */
  env: Record<string, string>;
  network: string;
};

/**
 * Creates the container with every limit CLAUDE.md §8 asks for.
 *
 * The host port is left empty on purpose: Docker picks a free one and we read
 * it back after start. Choosing one ourselves would mean either a reservation
 * in Redis that leaks when a worker dies, or a bind that races another process
 * between "is it free?" and "bind" — and the daemon already does this
 * atomically.
 */
export async function createDeploymentContainer(
  input: CreateContainerInput,
): Promise<{ container: Container; name: string }> {
  const docker = getDocker();
  const name = containerNameFor(input.deploymentId);
  const memoryBytes = env.DOCKER_MEMORY_MB * 1024 * 1024;

  // A retry rebuilds the same deployment id, so the name it wants may still be
  // taken by the attempt that failed. Removing it here is what makes "duplicate
  // deploy clicks must not create duplicate live containers" true at the Docker
  // level as well as in the database.
  await removeContainerByName(name, { force: true });

  let container: Container;
  try {
    container = await docker.createContainer({
      name,
      Image: input.imageTag,
      Labels: {
        [FORGE_LABELS.managed]: FORGE_MANAGED,
        [FORGE_LABELS.deployment]: input.deploymentId,
        [FORGE_LABELS.project]: input.projectId,
        [FORGE_LABELS.org]: input.orgId,
        [FORGE_LABELS.attempt]: String(input.attempt),
      },
      Env: Object.entries(input.env).map(([key, value]) => `${key}=${value}`),
      // No TTY: with one, stdout and stderr are merged into a single raw
      // stream and the distinction the dashboard colours by is lost. The cost
      // is that the log stream is multiplexed — see `log-demux.ts`.
      Tty: false,
      OpenStdin: false,
      AttachStdin: false,
      StopSignal: 'SIGTERM',
      ExposedPorts: { [portKey(input.appPort)]: {} },
      HostConfig: {
        PortBindings: {
          [portKey(input.appPort)]: [{ HostIp: env.DOCKER_HOST_IP, HostPort: '' }],
        },
        NetworkMode: input.network,
        Memory: memoryBytes,
        // Equal to Memory = swap disabled. Without this a container over its
        // memory cap swaps instead of being killed, and the cap means nothing.
        MemorySwap: memoryBytes,
        NanoCpus: Math.round(env.DOCKER_CPUS * 1e9),
        PidsLimit: env.DOCKER_PIDS_LIMIT,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        ReadonlyRootfs: env.DOCKER_READONLY_ROOTFS,
        // The one writable path, and it is neither executable nor setuid-able.
        Tmpfs: {
          '/tmp': `rw,noexec,nosuid,size=${String(env.DOCKER_TMPFS_MB)}m`,
        },
        // We own restarts (a crash must be visible as a failed health check,
        // not silently papered over by the daemon).
        RestartPolicy: { Name: 'no' },
        AutoRemove: false,
        // Docker's own tini as PID 1. Without it PID 1 is the project's start
        // command — commonly `npm`, which neither reaps zombies nor forwards
        // signals well: a `docker stop` makes it exit with "npm error signal
        // SIGTERM" instead of letting the app shut down.
        Init: true,
        // Bound the daemon's own log file too: a chatty app must not fill the
        // disk through a channel we are not the ones reading.
        LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      },
    });
  } catch (err) {
    throw dockerUnavailable(err);
  }

  return { container, name };
}

export async function startContainer(container: Container): Promise<void> {
  try {
    await container.start();
  } catch (err) {
    // 304 = already started, which is success for our purposes.
    if ((err as { statusCode?: number }).statusCode === 304) return;
    throw dockerUnavailable(err);
  }
}

export async function inspectContainer(
  containerId: string,
  appPort: number,
): Promise<ContainerState | null> {
  try {
    const inspect = (await getDocker()
      .getContainer(containerId)
      .inspect()) as unknown as InspectResult;
    return toState(inspect, appPort);
  } catch (err) {
    if (isDockerNotFound(err)) return null;
    throw dockerUnavailable(err);
  }
}

/**
 * Stops and removes a container. Never throws.
 *
 * Cleanup runs on the failure path, inside a `finally`, and often *while*
 * another error is propagating — a cleanup that throws would replace the real
 * reason a deployment failed with "no such container". Callers that need to
 * know log the boolean.
 */
export async function stopAndRemoveContainer(
  containerId: string,
  log: Logger,
  options: { graceSeconds?: number } = {},
): Promise<boolean> {
  const container = getDocker().getContainer(containerId);
  // `t` is a maximum, not a wait: a process that handles SIGTERM exits at once.
  // It only costs the full grace when the container ignores the signal, which
  // is why the orphan sweep passes 0 — an orphan has no claim on a graceful
  // shutdown, and N of them at boot must not serialise into N × grace.
  const grace = options.graceSeconds ?? env.DOCKER_STOP_GRACE_SECONDS;
  try {
    await container.stop({ t: grace });
  } catch (err) {
    // 304 = not running, 404 = already gone. Both mean "carry on to remove".
    if (!isDockerNotFound(err) && (err as { statusCode?: number }).statusCode !== 304) {
      log.warn({ err, containerId }, 'could not stop container; removing anyway');
    }
  }
  try {
    await container.remove({ force: true, v: true });
    return true;
  } catch (err) {
    if (isDockerNotFound(err)) return true;
    log.warn({ err, containerId }, 'could not remove container');
    return false;
  }
}

/** Removes a container by name, for the pre-create collision check. */
export async function removeContainerByName(
  name: string,
  options: { force?: boolean } = {},
): Promise<boolean> {
  try {
    await getDocker()
      .getContainer(name)
      .remove({ force: options.force ?? false, v: true });
    return true;
  } catch (err) {
    if (isDockerNotFound(err)) return false;
    throw dockerUnavailable(err);
  }
}

/**
 * Restarts a container in place.
 *
 * In place, rather than recreating: the point of a restart is to bounce the
 * process while keeping the identity — the same container id, the same
 * published host port, so the URL the user has open still works.
 */
export async function restartContainer(containerId: string): Promise<void> {
  try {
    await getDocker()
      .getContainer(containerId)
      .restart({ t: env.DOCKER_STOP_GRACE_SECONDS });
  } catch (err) {
    if (isDockerNotFound(err)) {
      throw badRequest('CONTAINER_GONE', 'That container no longer exists on this Docker host');
    }
    throw dockerUnavailable(err);
  }
}

// --- stats ------------------------------------------------------------------

type StatsResult = {
  read: string;
  cpu_stats: {
    cpu_usage: { total_usage: number; percpu_usage?: number[] | null };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats: {
    cpu_usage: { total_usage: number };
    system_cpu_usage?: number;
  };
  memory_stats: {
    usage?: number;
    limit?: number;
    stats?: { inactive_file?: number; cache?: number };
  };
  pids_stats: { current?: number };
};

/**
 * One stats sample for a container.
 *
 * `stream: false` asks the daemon for a single reading; it fills
 * `precpu_stats` from its own previous collection, which is what makes a CPU
 * percentage computable from one request. When it cannot (the container just
 * started, so there is no earlier sample) the deltas are non-positive and the
 * honest answer is 0 rather than a number derived from a division by zero.
 */
export async function sampleContainerStats(
  deploymentId: string,
  containerId: string,
  appPort: number,
): Promise<ContainerStats | null> {
  const docker: Docker = getDocker();
  let raw: StatsResult;
  let state: ContainerState | null;
  try {
    [raw, state] = await Promise.all([
      docker.getContainer(containerId).stats({ stream: false }) as unknown as Promise<StatsResult>,
      inspectContainer(containerId, appPort),
    ]);
  } catch (err) {
    if (isDockerNotFound(err)) return null;
    throw dockerUnavailable(err);
  }
  if (!state) return null;

  const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
  const systemDelta =
    (raw.cpu_stats.system_cpu_usage ?? 0) - (raw.precpu_stats.system_cpu_usage ?? 0);
  const cores = raw.cpu_stats.online_cpus ?? raw.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
  const cpuPercent =
    systemDelta > 0 && cpuDelta > 0
      ? Math.round(((cpuDelta / systemDelta) * cores * 100 + Number.EPSILON) * 10) / 10
      : 0;

  // `usage` includes the page cache, which is why `docker stats` subtracts
  // `inactive_file`. Reporting the raw number makes an idle app look like it is
  // sitting on 60 MB of memory it is not really using.
  const usage = raw.memory_stats.usage ?? 0;
  const cache = raw.memory_stats.stats?.inactive_file ?? raw.memory_stats.stats?.cache ?? 0;
  const memoryBytes = Math.max(0, usage - cache);
  const memoryLimitBytes = raw.memory_stats.limit ?? 0;

  return {
    deploymentId,
    containerId: state.id,
    cpuPercent,
    memoryBytes,
    memoryLimitBytes,
    memoryPercent:
      memoryLimitBytes > 0
        ? Math.round(((memoryBytes / memoryLimitBytes) * 100 + Number.EPSILON) * 10) / 10
        : 0,
    pids: raw.pids_stats.current ?? 0,
    pidsLimit: env.DOCKER_PIDS_LIMIT,
    state: state.status,
    at: new Date().toISOString(),
  };
}

// --- housekeeping -----------------------------------------------------------

export type ManagedContainer = {
  id: string;
  name: string;
  state: string;
  createdAt: number;
  deploymentId: string | null;
  projectId: string | null;
  orgId: string | null;
};

/**
 * Every container on this host that *we* created.
 *
 * Identified by label, not by name: a name is a string anyone can pick, a label
 * we stamped is a claim of ownership. `all: true` because a stopped orphan is
 * exactly the kind we want to find.
 */
export async function listManagedContainers(): Promise<ManagedContainer[]> {
  const docker = getDocker();
  let containers: {
    Id: string;
    Names: string[];
    State: string;
    Created: number;
    Labels: Record<string, string>;
  }[];
  try {
    containers = (await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${FORGE_LABELS.managed}=${FORGE_MANAGED}`] }),
    })) as typeof containers;
  } catch (err) {
    throw dockerUnavailable(err);
  }

  return containers.map((entry) => ({
    id: entry.Id,
    name: (entry.Names[0] ?? '').replace(/^\//, ''),
    state: entry.State,
    createdAt: entry.Created,
    deploymentId: entry.Labels[FORGE_LABELS.deployment] ?? null,
    projectId: entry.Labels[FORGE_LABELS.project] ?? null,
    orgId: entry.Labels[FORGE_LABELS.org] ?? null,
  }));
}
