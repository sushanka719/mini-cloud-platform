import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, badRequest, notFound } from '@forge/shared';
import { assertValidKey } from './keys.js';
import { HashingCounter } from './hashing.js';

/**
 * The local filesystem object store.
 *
 * Two invariants hold this together:
 *
 * 1. **Containment.** A key is joined onto the root and the result is checked
 *    to still be under it. Reads additionally `realpath()` the target and check
 *    again — a symlink planted inside the root is the only way to escape a
 *    join, and re-resolving is the only way to catch one.
 * 2. **Atomic commit.** A write is staged in a dot-prefixed temp file next to
 *    its target and `rename()`d in only after the whole stream was accepted, so
 *    a rejected, oversized or interrupted write leaves no object behind.
 *
 * Every operation is a `pipeline()` chain: nothing is buffered, so a slow
 * consumer throttles the disk instead of filling the heap (CONVENTIONS §6).
 */

export type ObjectStat = {
  key: string;
  sizeBytes: number;
  modifiedAt: Date;
};

export type PutResult = {
  key: string;
  sizeBytes: number;
  checksum: string;
};

export type PutOptions = {
  /** Reject once the stream passes this many bytes. */
  limitBytes?: number;
  /**
   * Last chance to refuse the write, run while the bytes are still only in the
   * temp file. Throwing here means no object and no rename.
   */
  beforeCommit?: () => void | Promise<void>;
};

/** A write staged but not yet committed — see `beginStagedWrite()`. */
export type StagedWrite = {
  key: string;
  /** Absolute path to write to. Nothing has created it yet. */
  tempPath: string;
  /** Absolute path it becomes on commit. */
  targetPath: string;
  commit(): Promise<ObjectStat>;
  abort(): Promise<void>;
};

/** Temp files are dot-prefixed so `assertValidKey` can never address one. */
const TEMP_PREFIX = '.tmp-';

function isErrnoException(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}

export class LocalObjectStore {
  /** Configured root, resolved to absolute but not symlink-resolved yet. */
  readonly root: string;
  /** `realpath()` of the root, resolved once the directory exists. */
  #realRoot: string | null = null;

  constructor(root: string) {
    if (!root) throw new Error('LocalObjectStore requires a storage root');
    this.root = resolve(root);
  }

  /**
   * The root may itself be a symlink (or live under one), so containment has to
   * be judged against its resolved form — otherwise every read under a
   * symlinked root would look like an escape.
   */
  async #resolvedRoot(): Promise<string> {
    if (this.#realRoot === null) {
      await mkdir(this.root, { recursive: true });
      this.#realRoot = await realpath(this.root);
    }
    return this.#realRoot;
  }

  /** Rejects anything that is not strictly inside `root`. */
  #assertInside(root: string, candidate: string): string {
    const rel = relative(root, candidate);
    if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw badRequest('OBJECT_KEY_ESCAPES_ROOT', 'Object key resolves outside the storage root');
    }
    return candidate;
  }

  /** Key → absolute path, containment checked. The target need not exist. */
  async #pathFor(key: string): Promise<string> {
    const root = await this.#resolvedRoot();
    return this.#assertInside(root, join(root, assertValidKey(key)));
  }

  /**
   * Key → absolute path of an object that exists, with symlinks resolved and
   * containment re-checked. This is the read path: it is the only check that
   * catches a symlink planted inside the root and pointing out of it.
   */
  async resolveExistingKey(key: string): Promise<string> {
    const root = await this.#resolvedRoot();
    const candidate = await this.#pathFor(key);

    let real: string;
    try {
      real = await realpath(candidate);
    } catch (err) {
      if (isErrnoException(err, 'ENOENT')) {
        throw notFound('OBJECT_NOT_FOUND', `No object stored at ${key}`);
      }
      throw err;
    }

    this.#assertInside(root, real);

    const info = await stat(real);
    if (!info.isFile()) {
      throw badRequest('OBJECT_NOT_A_FILE', `The object at ${key} is not a regular file`);
    }
    return real;
  }

  /**
   * Streams `source` into the object at `key`.
   *
   * The hash and the size come from the same pass that writes the bytes, and
   * the rename happens last, so the object either exists complete and hashed or
   * does not exist at all.
   */
  async put(key: string, source: Readable, options: PutOptions = {}): Promise<PutResult> {
    const validKey = assertValidKey(key);
    const staged = await this.beginStagedWrite(validKey);
    const counter = new HashingCounter(
      options.limitBytes === undefined ? {} : { limitBytes: options.limitBytes },
    );

    try {
      // 'wx' — refuse to write over a temp name we did not create ourselves.
      await pipeline(source, counter, createWriteStream(staged.tempPath, { flags: 'wx' }));
      await options.beforeCommit?.();
      await staged.commit();
    } catch (err) {
      await staged.abort();
      throw err;
    }

    return { key: validKey, sizeBytes: counter.bytes, checksum: counter.digest };
  }

  /**
   * Reserves a target and a temp path without creating either file. The caller
   * writes the temp file however it likes — including from a worker thread, which
   * is how `gzipObject()` keeps the CPU work off the event loop — then commits.
   */
  async beginStagedWrite(key: string): Promise<StagedWrite> {
    const validKey = assertValidKey(key);
    const targetPath = await this.#pathFor(validKey);
    await mkdir(dirname(targetPath), { recursive: true });
    const tempPath = join(dirname(targetPath), `${TEMP_PREFIX}${randomUUID()}`);

    return {
      key: validKey,
      tempPath,
      targetPath,
      commit: async () => {
        await rename(tempPath, targetPath);
        const info = await stat(targetPath);
        return { key: validKey, sizeBytes: info.size, modifiedAt: info.mtime };
      },
      // Abort must never mask the failure that caused it.
      abort: async () => {
        await rm(tempPath, { force: true }).catch(() => undefined);
      },
    };
  }

  /** Read stream for a stored object. Throws if it is missing. */
  async get(key: string): Promise<Readable> {
    const path = await this.resolveExistingKey(key);
    return createReadStream(path);
  }

  /** Size and mtime, or null when there is no object — used to detect drift. */
  async head(key: string): Promise<ObjectStat | null> {
    let path: string;
    try {
      path = await this.resolveExistingKey(key);
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) return null;
      throw err;
    }
    const info = await stat(path);
    return { key: assertValidKey(key), sizeBytes: info.size, modifiedAt: info.mtime };
  }

  /**
   * Walks the store under `prefix` and reports regular files only.
   *
   * Symlinks and staged temps are skipped: the first because following one
   * would report bytes that are not ours, the second because a temp file is not
   * an object yet. A missing prefix is an empty listing, not an error — that is
   * what a project with no uploads looks like.
   */
  async list(prefix?: string): Promise<ObjectStat[]> {
    const root = await this.#resolvedRoot();
    const base = prefix === undefined ? root : await this.#pathFor(prefix);
    const found: ObjectStat[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (isErrnoException(err, 'ENOENT') || isErrnoException(err, 'ENOTDIR')) return;
        throw err;
      }

      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const info = await lstat(full);
        found.push({
          key: relative(root, full).split(sep).join('/'),
          sizeBytes: info.size,
          modifiedAt: info.mtime,
        });
      }
    };

    await walk(base);
    return found;
  }

  /**
   * Removes one object. Returns false when there was nothing there, so a
   * caller can tell "deleted" from "already gone" without a prior `head()`.
   *
   * This deliberately unlinks the joined path rather than a resolved one: if the
   * entry is a symlink, removing the link is right and following it is not.
   */
  async delete(key: string): Promise<boolean> {
    const path = await this.#pathFor(key);
    try {
      await unlink(path);
      return true;
    } catch (err) {
      if (isErrnoException(err, 'ENOENT')) return false;
      if (isErrnoException(err, 'EISDIR') || isErrnoException(err, 'EPERM')) {
        throw badRequest('OBJECT_NOT_A_FILE', `The object at ${key} is not a regular file`);
      }
      throw err;
    }
  }

  /**
   * Removes a whole subtree — how a deleted project's bytes go away. Returns
   * the number of objects that were there, counted before the removal so the
   * caller can log what it dropped.
   *
   * An empty prefix is refused: `deletePrefix('')` would mean the entire store.
   */
  async deletePrefix(prefix: string): Promise<number> {
    const validPrefix = assertValidKey(prefix);
    const path = await this.#pathFor(validPrefix);
    const objects = await this.list(validPrefix);
    await rm(path, { recursive: true, force: true });
    return objects.length;
  }
}
