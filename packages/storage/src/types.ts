import type { Readable } from 'node:stream';

/** What `list`/`head` report about a stored object. */
export type ObjectStat = {
  key: string;
  sizeBytes: number;
  modifiedAt: Date;
};

/** What a completed write reports back. */
export type PutResult = {
  key: string;
  sizeBytes: number;
  /** sha256 of the bytes as written, computed in the same pass. */
  checksum: string;
};

export type PutOptions = {
  /** Abort the write once this many bytes have passed through. */
  limitBytes?: number;
  /** Accept a zero-byte object (default: reject — an empty upload is a bug). */
  allowEmpty?: boolean;
  /** File mode for the committed object. */
  mode?: number;
  /**
   * Last chance to reject before the temp file is renamed into place. Used by
   * the API to check `multipart`'s truncation flag, so a cut-short upload never
   * becomes a visible object.
   */
  beforeCommit?: (result: Omit<PutResult, 'key'>) => void | Promise<void>;
};

/**
 * The storage contract. Local filesystem today; the shape is deliberately
 * S3-ish (opaque string keys, streamed bodies) so swapping the implementation
 * would not touch callers (ARCHITECTURE §2.6).
 */
export interface ObjectStore {
  put(key: string, body: Readable, options?: PutOptions): Promise<PutResult>;
  get(key: string): Promise<Readable>;
  head(key: string): Promise<ObjectStat | null>;
  list(prefix?: string): Promise<ObjectStat[]>;
  delete(key: string): Promise<boolean>;
  deletePrefix(prefix: string): Promise<number>;
}
