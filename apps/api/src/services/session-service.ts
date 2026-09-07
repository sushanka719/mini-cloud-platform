import { env } from '@forge/config';
import { REDIS_KEYS } from '@forge/shared';
import { generateToken, hashToken } from '../lib/crypto.js';
import { getRedis } from '../lib/redis.js';

/**
 * Opaque sessions in Redis (ARCHITECTURE §8). Nothing about a session lives in
 * process memory, so any API replica can validate any cookie — that's what
 * makes the Phase 10 "multiple API replicas, no sticky sessions" demo honest.
 *
 * The raw token exists only in the client's cookie. Redis is keyed by
 * sha256(token), so a dump of the keyspace can't be replayed as a login.
 */

export type SessionRecord = {
  userId: string;
  createdAt: number;
  /** Truncated UA/IP, for a "your sessions" view later. Never used for auth. */
  userAgent?: string;
  ip?: string;
};

export type IssuedSession = {
  token: string;
  expiresAt: Date;
};

const TTL = env.SESSION_TTL_SECONDS;

export async function createSession(
  userId: string,
  context: { userAgent?: string; ip?: string } = {},
): Promise<IssuedSession> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const record: SessionRecord = {
    userId,
    createdAt: Date.now(),
    ...(context.userAgent ? { userAgent: context.userAgent.slice(0, 200) } : {}),
    ...(context.ip ? { ip: context.ip } : {}),
  };

  const redis = getRedis();
  // Pipeline so the session and its index entry land in one round trip.
  await redis
    .multi()
    .set(REDIS_KEYS.session(tokenHash), JSON.stringify(record), 'EX', TTL)
    .sadd(REDIS_KEYS.userSessions(userId), tokenHash)
    // The index is bounded by the longest-lived session it can contain; a stale
    // member is harmless (lookup just misses) and gets pruned on next revoke-all.
    .expire(REDIS_KEYS.userSessions(userId), TTL)
    .exec();

  return { token, expiresAt: new Date(Date.now() + TTL * 1000) };
}

export async function readSession(token: string): Promise<SessionRecord | null> {
  const tokenHash = hashToken(token);
  const raw = await getRedis().get(REDIS_KEYS.session(tokenHash));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as SessionRecord).userId === 'string'
    ) {
      return parsed as SessionRecord;
    }
    return null;
  } catch {
    // Corrupt value — treat as no session rather than 500 the request.
    return null;
  }
}

/**
 * Sliding expiry: refresh only once the session is past halfway, so an active
 * browser stays logged in without writing to Redis on every single request.
 */
export async function touchSession(token: string, record: SessionRecord): Promise<void> {
  const halfLifeMs = (TTL * 1000) / 2;
  if (Date.now() - record.createdAt < halfLifeMs) return;
  const tokenHash = hashToken(token);
  await getRedis().expire(REDIS_KEYS.session(tokenHash), TTL);
}

export async function destroySession(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  const redis = getRedis();
  const record = await readSession(token);
  const tx = redis.multi().del(REDIS_KEYS.session(tokenHash));
  if (record) tx.srem(REDIS_KEYS.userSessions(record.userId), tokenHash);
  await tx.exec();
}

/** Log out everywhere — used on password change and account lockout. */
export async function destroyAllSessions(userId: string): Promise<number> {
  const redis = getRedis();
  const indexKey = REDIS_KEYS.userSessions(userId);
  const hashes = await redis.smembers(indexKey);
  if (hashes.length === 0) return 0;
  const removed = await redis.del(...hashes.map((h) => REDIS_KEYS.session(h)));
  await redis.del(indexKey);
  return removed;
}
