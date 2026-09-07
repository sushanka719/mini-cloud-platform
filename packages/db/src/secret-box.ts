import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '@forge/config';

/**
 * Symmetric encryption for project env vars at rest (DATA_MODEL §5).
 *
 * This lives in `@forge/db` because `project_env_vars.value_enc` is a `bytea`
 * column and its wire format is therefore a persistence detail — and because
 * both writers need it: the API encrypts on write, and from Phase 6 the worker
 * decrypts to inject env vars into a build. Duplicating the format in two apps
 * would be the only alternative.
 *
 * Wire format, one bytea column:
 *   [0]      version byte
 *   [1..13)  12-byte GCM iv
 *   [13..29) 16-byte auth tag
 *   [29..]   ciphertext
 *
 * The version byte exists so a future key rotation or algorithm change can read
 * old rows instead of orphaning them.
 */

const VERSION = 1;
const IV_BYTES = 12; // 96-bit nonce — the size GCM is specified for
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

// Validated as exactly 32 bytes by the env schema, so this can't be short.
const key = Buffer.from(env.ENCRYPTION_KEY, 'base64');

export function encryptSecret(plaintext: string): Buffer {
  // A fresh random iv per write — reusing one under the same key breaks GCM.
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

/** Throws if the payload was truncated, tampered with, or written under another key. */
export function decryptSecret(payload: Buffer): string {
  if (payload.length < HEADER_BYTES) {
    throw new Error('encrypted value is truncated');
  }
  const version = payload[0];
  if (version !== VERSION) {
    throw new Error(`unsupported secret format version ${String(version)}`);
  }
  const iv = payload.subarray(1, 1 + IV_BYTES);
  const tag = payload.subarray(1 + IV_BYTES, HEADER_BYTES);
  const ciphertext = payload.subarray(HEADER_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
