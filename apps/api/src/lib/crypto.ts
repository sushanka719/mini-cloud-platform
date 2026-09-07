import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { API_KEY_LOOKUP_LENGTH, API_KEY_PREFIX } from '@forge/shared';

/**
 * Password hashing and opaque-token handling.
 *
 * Two different hashes on purpose:
 *  - passwords → argon2id (slow, salted; passwords are low-entropy and guessable)
 *  - tokens/keys → sha256 (fast; 256 bits of random has nothing to guess, and
 *    this runs on every authenticated request)
 */

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB — OWASP's argon2id baseline
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    // A malformed stored hash must read as "wrong password", not crash a login.
    return false;
  }
}

/**
 * Burns roughly the same time as a real verify. Called when the email doesn't
 * exist so response timing doesn't reveal which accounts are registered.
 */
export async function fakeVerifyPassword(): Promise<void> {
  await argon2.hash('timing-equalisation', ARGON2_OPTIONS);
}

/** 256 bits of CSPRNG entropy, url-safe. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** What we actually store/look up. Raw tokens are never persisted anywhere. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Length-safe constant-time compare for hex digests. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export type GeneratedApiKey = {
  /** Full key — returned to the caller once, then unrecoverable. */
  key: string;
  /** Non-secret leading slice, stored plaintext and used for lookup. */
  prefix: string;
  keyHash: string;
};

export function generateApiKey(): GeneratedApiKey {
  const key = `${API_KEY_PREFIX}${generateToken(32)}`;
  return {
    key,
    prefix: key.slice(0, API_KEY_LOOKUP_LENGTH),
    keyHash: hashToken(key),
  };
}
