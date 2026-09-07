import { badRequest } from '@forge/shared';

/**
 * Object keys.
 *
 * A key is an opaque, S3-shaped string — `<orgId>/<projectId>/sources/<uuid>.zip`
 * — never a filesystem path. Only `LocalObjectStore` turns one into a path, and
 * it does so under a root it re-checks on every operation. Keeping the layout
 * builders here is what stops the API and the worker from disagreeing about
 * where a project's objects live.
 */

/** Long enough for the layout plus a filename, short enough to stay under any PATH_MAX. */
const MAX_KEY_LENGTH = 512;
const MAX_SEGMENT_LENGTH = 255;

/**
 * A segment must start with an alphanumeric. That single rule is what rejects
 * `.` and `..` (and every other dot-prefixed name), so traversal is impossible
 * to express as a key rather than merely filtered out afterwards. Dots are
 * allowed *inside* a segment because extensions need them.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function reject(key: string, reason: string): never {
  // The key is caller-constructed, never echoed from a request body, so it is
  // safe to include in the message.
  throw badRequest('INVALID_OBJECT_KEY', `Invalid object key ${JSON.stringify(key)}: ${reason}`);
}

/**
 * The one validator. Every public entry point in this package runs a key
 * through here before it is allowed anywhere near a path join.
 */
export function assertValidKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) reject(String(key), 'must be a non-empty string');
  if (key.length > MAX_KEY_LENGTH) reject(key, `must be at most ${MAX_KEY_LENGTH} characters`);
  if (key.includes('\0')) reject(key, 'must not contain NUL');
  if (key.includes('\\')) reject(key, 'must not contain backslashes');
  if (key.startsWith('/') || key.endsWith('/')) reject(key, 'must not start or end with "/"');

  for (const segment of key.split('/')) {
    if (segment.length === 0) reject(key, 'must not contain an empty segment');
    if (segment.length > MAX_SEGMENT_LENGTH) {
      reject(key, `segment "${segment}" exceeds ${MAX_SEGMENT_LENGTH} characters`);
    }
    if (segment !== segment.trim()) reject(key, `segment "${segment}" has leading or trailing whitespace`);
    if (!SEGMENT.test(segment)) {
      reject(key, `segment "${segment}" must start with a letter or digit and contain only [A-Za-z0-9._-]`);
    }
  }

  return key;
}

/** Directory name per `FileKind`, so `inferKind()` and the layout agree. */
const KIND_DIRECTORY = {
  source: 'sources',
  artifact: 'artifacts',
  log: 'logs',
} as const;

/** Everything belonging to one org. */
export function orgPrefix(orgId: string): string {
  return assertValidKey(orgId);
}

/** Everything belonging to one project — the unit `deletePrefix()` removes. */
export function projectPrefix(orgId: string, projectId: string): string {
  return assertValidKey(`${orgId}/${projectId}`);
}

/** Uploaded source archives. */
export function sourceKey(orgId: string, projectId: string, objectName: string): string {
  return assertValidKey(`${orgId}/${projectId}/${KIND_DIRECTORY.source}/${objectName}`);
}

/** Build outputs — gzip artifacts produced from a source or a log. */
export function artifactKey(orgId: string, projectId: string, objectName: string): string {
  return assertValidKey(`${orgId}/${projectId}/${KIND_DIRECTORY.artifact}/${objectName}`);
}

/** Archived build logs. */
export function logKey(orgId: string, projectId: string, objectName: string): string {
  return assertValidKey(`${orgId}/${projectId}/${KIND_DIRECTORY.log}/${objectName}`);
}
