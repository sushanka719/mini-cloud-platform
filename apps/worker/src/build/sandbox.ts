import { mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { badRequest } from '@forge/shared';

/**
 * The build sandbox: one directory per deployment, and the only place on disk
 * the pipeline is allowed to write.
 *
 * This is the filesystem half of CLAUDE.md §8. Everything a build touches —
 * the extracted archive, the working directory the commands run in, the paths
 * inside a hostile tar entry — is resolved through `resolveInside()`, which
 * refuses anything that lands outside the root. `realpath()` is re-checked on
 * the *existing* path, because a symlink planted inside the sandbox is the one
 * escape a plain `join` cannot see (the same two-step check `LocalObjectStore`
 * uses for object keys).
 *
 * Layout:
 *   <BUILD_ROOT>/<deploymentId>-<random>/
 *     archive        (only when the stored source had to be materialised)
 *     source/        (extraction target; the build's working directory is here)
 */
function isMissing(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export class BuildSandbox {
  /** Absolute, symlink-resolved sandbox root. */
  readonly root: string;
  /** Where the source archive is extracted — the build's tree. */
  readonly sourceDir: string;

  private constructor(root: string) {
    this.root = root;
    this.sourceDir = join(root, 'source');
  }

  /**
   * Creates `<BUILD_ROOT>/<deploymentId>-<random>/source`.
   *
   * The random suffix matters: a retry of the same deployment must not inherit
   * a half-extracted tree from the attempt that failed, and `mkdtemp` gives us
   * a fresh directory without a "does it exist?" race.
   */
  static async create(buildRoot: string, deploymentId: string): Promise<BuildSandbox> {
    await mkdir(buildRoot, { recursive: true });
    // Resolve the root itself first: BUILD_ROOT may sit under a symlink, and
    // then every path inside it would look like an escape.
    const realRoot = await realpath(buildRoot);
    const dir = await mkdtemp(join(realRoot, `${deploymentId}-`));
    const sandbox = new BuildSandbox(dir);
    await mkdir(sandbox.sourceDir, { recursive: true });
    return sandbox;
  }

  /** Rejects a path that is not strictly inside `base`. */
  private static assertInside(base: string, candidate: string, what: string): string {
    const rel = relative(base, candidate);
    if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw badRequest('PATH_ESCAPES_SANDBOX', `${what} resolves outside the build sandbox`);
    }
    return candidate;
  }

  /**
   * Joins a relative path onto the sandbox and proves the result is inside it.
   * The target need not exist — this is the check for a path we are about to
   * create (an extracted entry, the log file).
   */
  resolveInside(relativePath: string, base = this.root): string {
    if (relativePath.includes('\0')) {
      throw badRequest('PATH_HAS_NUL', 'Path contains a NUL byte');
    }
    if (isAbsolute(relativePath)) {
      throw badRequest('PATH_IS_ABSOLUTE', `Absolute path ${relativePath} is not allowed here`);
    }
    BuildSandbox.assertInside(this.root, base, 'base directory');
    return BuildSandbox.assertInside(
      this.root,
      resolve(base, relativePath),
      `"${relativePath}"`,
    );
  }

  /**
   * Same, for a path that already exists: symlinks are resolved and
   * containment re-checked. This is what catches a symlink inside the tree
   * pointing at `/etc`.
   */
  async resolveExistingInside(relativePath: string, base = this.root): Promise<string> {
    const candidate = this.resolveInside(relativePath, base);
    return BuildSandbox.assertInside(this.root, await realpath(candidate), `"${relativePath}"`);
  }

  /**
   * The directory the build commands run in: `source/` plus the project's
   * `root_dir`, both validated.
   *
   * Archives are commonly created with a single wrapping directory
   * (`my-app/package.json` — what `git archive` and GitHub's "download zip"
   * produce), so when the extraction root holds exactly one entry and it is a
   * directory, we descend into it. That is reported as a log line rather than
   * done silently, because it changes where every command runs.
   */
  async resolveWorkdir(rootDir: string): Promise<{ dir: string; descendedInto: string | null }> {
    let base = this.sourceDir;
    let descendedInto: string | null = null;

    const entries = await readdir(base, { withFileTypes: true });
    const visible = entries.filter((entry) => !entry.name.startsWith('.'));
    const only = visible.length === 1 ? visible[0] : undefined;
    if (only?.isDirectory()) {
      base = this.resolveInside(only.name, base);
      descendedInto = only.name;
    }

    // `.` is the default and means "the tree as extracted".
    let dir: string;
    if (rootDir === '.' || rootDir === '') {
      dir = base;
    } else {
      try {
        dir = await this.resolveExistingInside(rootDir, base);
      } catch (err) {
        // `realpath` puts the *absolute* path in its ENOENT message, which
        // would put this machine's directory layout into an API response and a
        // build log. The project only needs to know its own rootDir is wrong.
        if (isMissing(err)) {
          throw badRequest(
            'ROOT_DIR_NOT_FOUND',
            `rootDir "${rootDir}" does not exist in the source archive`,
          );
        }
        throw err;
      }
    }

    const info = await stat(dir);
    if (!info.isDirectory()) {
      throw badRequest('ROOT_DIR_NOT_A_DIRECTORY', `rootDir "${rootDir}" is not a directory`);
    }
    return { dir, descendedInto };
  }

  /** Removes the whole sandbox. Never throws — cleanup must not mask a failure. */
  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Removes sandboxes left behind by a process that died mid-build.
 *
 * A SIGKILL'd worker never runs its `finally`, so without this the build root
 * grows forever. Age-based rather than pid-based: another *live* worker may own
 * a sandbox right now, and `BUILD_ROOT` is shared between replicas.
 */
export async function pruneStaleSandboxes(
  buildRoot: string,
  maxAgeMs: number,
): Promise<{ removed: number; bytesFreed: number }> {
  let removed = 0;
  let bytesFreed = 0;
  let entries;
  try {
    entries = await readdir(buildRoot, { withFileTypes: true });
  } catch {
    // No build root yet — nothing has ever been built here.
    return { removed, bytesFreed };
  }

  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Dot-directories under the build root are ours, not sandboxes — the
    // shared npm cache lives in one and must survive pruning.
    if (entry.name.startsWith('.')) continue;
    const dir = join(buildRoot, entry.name);
    try {
      const info = await stat(dir);
      if (info.mtimeMs > cutoff) continue;
      bytesFreed += await directorySize(dir);
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Raced with another worker's cleanup; nothing to do.
    }
  }
  return { removed, bytesFreed };
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        total += await stat(full)
          .then((s) => s.size)
          .catch(() => 0);
      }
    }
  };
  await walk(dir);
  return total;
}
