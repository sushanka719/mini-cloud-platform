import { createReadStream } from 'node:fs';
import { open, mkdir, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { extract as extractTar, type ReadEntry } from 'tar';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { badRequest } from '@forge/shared';
import type { BuildSandbox } from './sandbox.js';

/**
 * Unpacking an uploaded source archive into the sandbox.
 *
 * The archive is **untrusted input** — it came in over HTTP from whoever owns
 * the project — so extraction is where two classic attacks land, and both are
 * blocked here rather than trusted to the library:
 *
 *  - **Path traversal** ("zip slip"): an entry named `../../.ssh/authorized_keys`.
 *    Every entry path goes through `sandbox.resolveInside()` before a byte is
 *    written, and links (symbolic or hard) are refused outright — a link is a
 *    path that resolves *later*, which is exactly the check we cannot do up
 *    front.
 *  - **Bombs**: a 100 KB archive that expands to 40 GB, or one holding a
 *    million empty files. Both a byte budget and a file-count budget are
 *    enforced while unpacking, so it fails at the entry that crosses the line
 *    rather than when the disk fills.
 *
 * Format is decided by magic bytes, not by the filename: the extension is
 * caller-supplied metadata, the first four bytes are the file.
 */

export type ArchiveFormat = 'zip' | 'tar';

export type ExtractLimits = {
  maxBytes: number;
  maxFiles: number;
};

export type ExtractResult = {
  format: ArchiveFormat;
  files: number;
  directories: number;
  bytes: number;
  /** Entries refused for containment/type reasons, with the reason. */
  skipped: string[];
};

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_EMPTY_MAGIC = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
/** POSIX tar puts "ustar" at offset 257. */
const TAR_MAGIC_OFFSET = 257;

/** How many refused entries we bother naming in the log. */
const MAX_REPORTED_SKIPS = 20;

/**
 * Reads the header and decides what the file actually is.
 *
 * gzip is reported as `tar`: `tar.x` sniffs and inflates gzip itself, so a
 * `.tgz`, a `.tar.gz` and a bare `.gz` wrapping a tarball all take one path. A
 * gzipped *non*-tar fails inside the tar reader with a clear parse error, which
 * is the honest outcome — a single compressed file is not a project.
 */
export async function detectArchiveFormat(path: string): Promise<ArchiveFormat> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(TAR_MAGIC_OFFSET + 6);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead === 0) throw badRequest('ARCHIVE_EMPTY', 'The source archive is empty');

    if (header.subarray(0, 4).equals(ZIP_MAGIC) || header.subarray(0, 4).equals(ZIP_EMPTY_MAGIC)) {
      return 'zip';
    }
    if (header.subarray(0, 2).equals(GZIP_MAGIC)) return 'tar';
    if (
      bytesRead >= TAR_MAGIC_OFFSET + 5 &&
      header.subarray(TAR_MAGIC_OFFSET, TAR_MAGIC_OFFSET + 5).toString('latin1') === 'ustar'
    ) {
      return 'tar';
    }
    throw badRequest(
      'ARCHIVE_UNRECOGNIZED',
      'The source archive is not a zip or tar file (checked by magic bytes)',
    );
  } finally {
    await handle.close();
  }
}

/** Extraction budget shared by both readers. */
class Budget {
  files = 0;
  directories = 0;
  bytes = 0;
  readonly skipped: string[] = [];

  constructor(private readonly limits: ExtractLimits) {}

  skip(entry: string, reason: string): void {
    if (this.skipped.length < MAX_REPORTED_SKIPS) this.skipped.push(`${entry} (${reason})`);
  }

  countFile(): void {
    this.files += 1;
    if (this.files > this.limits.maxFiles) {
      throw badRequest(
        'ARCHIVE_TOO_MANY_FILES',
        `The archive holds more than ${this.limits.maxFiles} files`,
      );
    }
  }

  countBytes(size: number): void {
    this.bytes += size;
    if (this.bytes > this.limits.maxBytes) {
      throw badRequest(
        'ARCHIVE_TOO_LARGE',
        `The archive expands past the ${this.limits.maxBytes}-byte extraction limit`,
      );
    }
  }
}

/** Thrown for an entry that tries to leave the sandbox — always fatal. */
function unsafeEntry(entryPath: string, reason: string): Error {
  return badRequest(
    'ARCHIVE_UNSAFE_ENTRY',
    `The source archive contains an unsafe entry (${reason}): ${JSON.stringify(entryPath)}`,
  );
}

/**
 * Decides whether one entry may be written, and where.
 *
 * Two different outcomes, on purpose:
 *
 *  - **Refused and skipped** (returns null): links, fifos, sockets, devices.
 *    Real tarballs of real projects contain symlinks, so refusing the whole
 *    upload over one would break legitimate archives. They are reported in the
 *    build log so the omission is visible.
 *  - **Refused and fatal** (throws): anything whose *path* tries to leave the
 *    sandbox. An archive that contains `../../../.ssh/authorized_keys` is not a
 *    project with one bad file in it — it is an attack, and extracting "the
 *    rest of it" would be a strange thing to do. Both readers therefore stop.
 *
 * Shared by zip and tar so the two cannot drift apart on a security rule.
 */
function targetFor(
  sandbox: BuildSandbox,
  destDir: string,
  rawPath: string,
  kind: 'file' | 'directory' | 'link' | 'other',
  budget: Budget,
): string | null {
  if (kind === 'link') {
    // A symlink's containment can only be judged after it is followed, and
    // following it is the vulnerability. A build does not need them.
    budget.skip(rawPath, 'links are not extracted');
    return null;
  }
  if (kind === 'other') {
    budget.skip(rawPath, 'not a regular file or directory');
    return null;
  }
  // Normalise separators: a zip written on Windows uses backslashes, which
  // POSIX would treat as part of the filename rather than as a separator.
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized === '' || normalized === '.') return null;
  if (rawPath.startsWith('/') || /^[A-Za-z]:/.test(rawPath)) {
    throw unsafeEntry(rawPath, 'absolute path');
  }
  if (normalized.split('/').includes('..')) {
    throw unsafeEntry(rawPath, 'path traversal');
  }
  try {
    return sandbox.resolveInside(normalized, destDir);
  } catch {
    throw unsafeEntry(rawPath, 'escapes the sandbox');
  }
}

export async function extractArchive(
  archivePath: string,
  sandbox: BuildSandbox,
  destDir: string,
  limits: ExtractLimits,
): Promise<ExtractResult> {
  const format = await detectArchiveFormat(archivePath);
  const budget = new Budget(limits);

  if (format === 'zip') {
    await extractZip(archivePath, sandbox, destDir, budget);
  } else {
    await extractTarball(archivePath, sandbox, destDir, budget);
  }

  if (budget.files === 0) {
    throw badRequest(
      'ARCHIVE_NO_FILES',
      'The source archive contained no extractable files (every entry was refused or it is empty)',
    );
  }

  return {
    format,
    files: budget.files,
    directories: budget.directories,
    bytes: budget.bytes,
    skipped: budget.skipped,
  };
}

/**
 * tar via `node-tar`.
 *
 * `preservePaths: false` is the library's own traversal guard; the `filter`
 * below is ours, and it is the one that runs against the sandbox root the rest
 * of the pipeline uses. Two independent checks, because this one matters.
 *
 * `strict` is deliberately off: it turns every tar warning into an opaque
 * `TAR_ENTRY_*` error, including the benign ones, so a project would fail with
 * "stripping / from absolute path" instead of a message that says what to fix.
 * Warnings are classified here instead — path-shaped ones are fatal with our
 * own code, the rest are reported into the build log.
 */
async function extractTarball(
  archivePath: string,
  sandbox: BuildSandbox,
  destDir: string,
  budget: Budget,
): Promise<void> {
  let refusal: Error | null = null;

  await extractTar({
    file: archivePath,
    cwd: destDir,
    preservePaths: false,
    // Nothing in the archive gets to decide file ownership.
    preserveOwner: false,
    strict: false,
    filter: (entryPath: string, entry: ReadEntry | { size?: number }) => {
      if (refusal) return false;
      const type = 'type' in entry ? entry.type : 'File';
      const kind =
        type === 'Directory'
          ? 'directory'
          : type === 'File' || type === 'ContiguousFile' || type === 'OldFile'
            ? 'file'
            : type === 'SymbolicLink' || type === 'Link'
              ? 'link'
              : 'other';
      try {
        const target = targetFor(sandbox, destDir, entryPath, kind, budget);
        if (target === null) return false;
        if (kind === 'directory') {
          budget.directories += 1;
          return true;
        }
        budget.countFile();
        budget.countBytes(entry.size ?? 0);
        return true;
      } catch (err) {
        // A budget breach must stop the extraction, but throwing out of the
        // filter would surface as an opaque tar error — record it and refuse
        // everything from here on.
        refusal = err instanceof Error ? err : new Error(String(err));
        return false;
      }
    },
    onwarn: (code, message) => {
      // node-tar reports a path it had to rewrite as a warning. A rewritten
      // path is exactly the case our filter refuses, so if one gets here it is
      // fatal — and the message is replaced with ours, which names the entry.
      if (/absolute path|contains '\.\.'|outside/i.test(message)) {
        refusal ??= unsafeEntry(message, `tar warning ${code}`);
        return;
      }
      budget.skip(code, message);
    },
  });

  if (refusal) throw refusal;
}

/**
 * zip via `yauzl`, entry by entry.
 *
 * `lazyEntries` means we pull one entry at a time and only open a read stream
 * once the path has been approved — a rejected entry never has its bytes
 * touched, and the whole thing stays streaming (no archive is held in memory).
 */
async function extractZip(
  archivePath: string,
  sandbox: BuildSandbox,
  destDir: string,
  budget: Budget,
): Promise<void> {
  const zip = await openZip(archivePath);

  await new Promise<void>((resolveDone, rejectDone) => {
    const fail = (err: unknown) => {
      zip.close();
      rejectDone(normalizeZipError(err));
    };

    // yauzl surfaces a rejected entry name on the zipfile, not per entry.
    zip.on('error', fail);
    zip.on('end', () => resolveDone());

    zip.on('entry', (entry: Entry) => {
      void (async () => {
        try {
          // The high 16 bits of the external attributes are the unix mode;
          // 0xa000 is S_IFLNK. A zip can carry symlinks, and we refuse them.
          const mode = entry.externalFileAttributes >>> 16;
          const isSymlink = (mode & 0xf000) === 0xa000;
          const isDirectory = /\/$/.test(entry.fileName);
          const kind = isSymlink ? 'link' : isDirectory ? 'directory' : 'file';

          const target = targetFor(sandbox, destDir, entry.fileName, kind, budget);
          if (target === null) {
            zip.readEntry();
            return;
          }

          if (kind === 'directory') {
            budget.directories += 1;
            await mkdir(target, { recursive: true });
            zip.readEntry();
            return;
          }

          budget.countFile();
          budget.countBytes(entry.uncompressedSize);

          await mkdir(dirname(target), { recursive: true });
          const source = await openZipEntry(zip, entry);
          // 'wx' — an entry must not overwrite something already extracted
          // (two entries claiming one path is itself an attack shape).
          await pipeline(source, createWriteStream(target, { flags: 'wx' }));
          // Keep only the executable bit the archive asked for; never setuid.
          if (mode & 0o111) await chmod(target, 0o755).catch(() => undefined);

          zip.readEntry();
        } catch (err) {
          fail(err);
        }
      })();
    });

    zip.readEntry();
  });
}

/**
 * yauzl validates entry names itself and rejects `..`, absolute paths and
 * backslashes before handing us the entry — a second, independent zip-slip
 * guard. Its message is accurate but generic, so it is re-labelled with the
 * same code our own check produces; either way the archive is refused.
 */
function normalizeZipError(err: unknown): Error {
  const error = err instanceof Error ? err : new Error(String(err));
  if (/invalid relative path|absolute path|invalid characters in fileName/i.test(error.message)) {
    return badRequest(
      'ARCHIVE_UNSAFE_ENTRY',
      `The source archive contains an unsafe entry: ${error.message}`,
    );
  }
  return error;
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolveZip, rejectZip) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) {
        rejectZip(
          badRequest('ARCHIVE_UNREADABLE', `Could not read the zip archive: ${err?.message ?? ''}`),
        );
        return;
      }
      resolveZip(zip);
    });
  });
}

function openZipEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolveStream, rejectStream) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        rejectStream(err ?? new Error(`Could not read zip entry ${entry.fileName}`));
        return;
      }
      resolveStream(stream);
    });
  });
}

/**
 * Materialises a stored source object as a local file the extractor can read.
 *
 * A plain upload is read straight from the object store — no copy. A gzipped
 * one (`files.compression = 'gzip'`, what Phase 3's artifact path produces) is
 * inflated into the sandbox first, because the gzip wrapper would otherwise
 * hide the real archive's magic bytes.
 */
export async function materializeArchive(
  sandbox: BuildSandbox,
  objectPath: string,
  compression: string | null,
): Promise<string> {
  if (compression !== 'gzip') return objectPath;

  const { createGunzip } = await import('node:zlib');
  const target = join(sandbox.root, 'archive');
  await pipeline(createReadStream(objectPath), createGunzip(), createWriteStream(target));
  return target;
}
