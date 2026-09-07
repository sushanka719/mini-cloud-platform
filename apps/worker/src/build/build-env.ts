import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '@forge/config';
import type { DeploymentRow, ProjectRow, ResolvedEnvVar } from '@forge/db';
import type { BuildSandbox } from './sandbox.js';

/**
 * The environment a build process gets.
 *
 * Built from nothing rather than inherited. `process.env` in the worker holds
 * `DATABASE_URL`, `REDIS_URL` and `ENCRYPTION_KEY`; passing it to code we are
 * about to execute on behalf of a user would hand over the database and the
 * key every project's secrets are encrypted with. So the child gets an
 * explicit allowlist plus the project's own variables, and nothing else
 * (CLAUDE.md §8).
 *
 * `HOME` and `TMPDIR` point inside the sandbox so a build that writes to
 * either lands somewhere we clean up. The npm cache is deliberately *outside*
 * the sandbox and shared: an isolated HOME would otherwise re-download every
 * dependency on every deployment. That is a speed/isolation trade-off which
 * stops mattering in Phase 7, when the build moves into a container.
 */

/** Names a project may not set, because the sandbox depends on them. */
const RESERVED = new Set(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'npm_config_cache']);

export type BuildEnvironment = {
  vars: Record<string, string>;
  /** Values to mask out of the build log (secret vars only). */
  secrets: string[];
  /** Non-secret keys, safe to name in the log. */
  visibleKeys: string[];
  /** Secret keys — named, never valued. */
  secretKeys: string[];
};

export async function buildEnvironment(
  sandbox: BuildSandbox,
  deployment: DeploymentRow,
  project: ProjectRow,
  projectVars: readonly ResolvedEnvVar[],
): Promise<BuildEnvironment> {
  const home = join(sandbox.root, 'home');
  const tmp = join(sandbox.root, 'tmp');
  const npmCache = join(env.BUILD_ROOT, '.npm-cache');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(tmp, { recursive: true }),
    mkdir(npmCache, { recursive: true }),
  ]);

  const base: Record<string, string> = {
    // `spawn` resolves the program on PATH, so without this nothing runs.
    PATH: env.BUILD_PATH ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TMPDIR: tmp,
    npm_config_cache: npmCache,
    LANG: 'C.UTF-8',
    // Non-interactive: every sane build tool reads this and stops asking.
    CI: '1',
    // ANSI escapes would be persisted verbatim into `deployment_events` and
    // rendered as mojibake in the browser. Ask for plain text instead.
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
    // What the app is expected to listen on once Phase 7 starts it.
    PORT: String(project.app_port),
    FORGE_DEPLOYMENT_ID: deployment.id,
    FORGE_PROJECT_ID: project.id,
    FORGE_ORG_ID: project.org_id,
    FORGE_ATTEMPT: String(deployment.attempt),
    // Which worker is running this build (Phase 10). Read off the row rather
    // than passed down from the registry, so it needs no plumbing and cannot
    // disagree with what the fleet view shows. Empty is impossible here — the
    // claim wrote it — but the column is nullable, so it is handled.
    FORGE_WORKER_ID: deployment.worker_id ?? '',
  };

  const vars: Record<string, string> = { ...base };
  const secrets: string[] = [];
  const visibleKeys: string[] = [];
  const secretKeys: string[] = [];

  for (const variable of projectVars) {
    if (RESERVED.has(variable.key)) continue;
    vars[variable.key] = variable.value;
    if (variable.isSecret) {
      secrets.push(variable.value);
      secretKeys.push(variable.key);
    } else {
      visibleKeys.push(variable.key);
    }
  }

  return { vars, secrets, visibleKeys, secretKeys };
}

/**
 * Names a project may not set at *run* time, because the container's
 * read-only root filesystem depends on them.
 *
 * A shorter list than the build's: `PATH` is the image's business and a project
 * legitimately might want to extend it, but `HOME`/`TMPDIR`/npm's cache must
 * keep pointing at the tmpfs or the very first write fails with EROFS.
 */
const RESERVED_RUNTIME = new Set(['HOME', 'TMPDIR', 'TMP', 'TEMP', 'npm_config_cache', 'PORT']);

/**
 * The environment the *container* gets.
 *
 * Passed to `container create`, never written into the image. An image layer is
 * a durable, exportable artifact: a secret baked into one outlives the
 * deployment, survives `docker save`, and leaks with the image. Container
 * environment lives exactly as long as the container does (CLAUDE.md §8).
 *
 * `PORT` is ours to set — it is the contract with the app about which port the
 * published mapping expects it on, so a project overriding it would break its
 * own health check.
 */
export function containerEnvironment(
  deployment: DeploymentRow,
  project: ProjectRow,
  projectVars: readonly ResolvedEnvVar[],
): BuildEnvironment {
  const vars: Record<string, string> = {
    PORT: String(project.app_port),
    HOST: '0.0.0.0',
    NO_COLOR: '1',
    FORGE_DEPLOYMENT_ID: deployment.id,
    FORGE_PROJECT_ID: project.id,
    FORGE_ORG_ID: project.org_id,
    FORGE_ATTEMPT: String(deployment.attempt),
    FORGE_WORKER_ID: deployment.worker_id ?? '',
  };
  const secrets: string[] = [];
  const visibleKeys: string[] = [];
  const secretKeys: string[] = [];

  for (const variable of projectVars) {
    if (RESERVED_RUNTIME.has(variable.key)) continue;
    vars[variable.key] = variable.value;
    if (variable.isSecret) {
      secrets.push(variable.value);
      secretKeys.push(variable.key);
    } else {
      visibleKeys.push(variable.key);
    }
  }

  return { vars, secrets, visibleKeys, secretKeys };
}
