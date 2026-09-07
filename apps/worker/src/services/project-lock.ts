import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { REDIS_KEYS } from '@forge/shared';
import type { Logger } from '@forge/config';
import { getRedis } from '../lib/redis.js';

/**
 * "One live container per project", as a Redis lock.
 *
 * Hand-rolled rather than pulled from a library, because the interesting part
 * is exactly what a library would hide (CLAUDE.md §4, multi-process shared
 * state). Three properties matter and each one is a specific line of code:
 *
 *  - **Mutual exclusion** — `SET key token NX PX ttl`. One command, so two
 *    workers cannot both observe "free" and both take it.
 *  - **Ownership** — the value is a token unique to this holder, and release
 *    compares it *inside* Redis. A `GET` then `DEL` from the client would let a
 *    holder whose lock had already expired delete the next holder's lock.
 *  - **Liveness** — a TTL, so a worker that is SIGKILLed while holding it does
 *    not block its project forever, plus a renewal timer so a slow-but-alive
 *    holder does not lose it mid-deployment.
 *
 * What it deliberately is *not*: a consensus lock. A single Redis is a single
 * point of failure and a paused-then-resumed process can hold a lock it no
 * longer owns. The consequence here is bounded — two containers briefly
 * published for one project — and the database's `active_deployment_id` is
 * still the single answer to "which one is serving".
 */

/** Renew when this fraction of the TTL has passed. */
const RENEW_AT = 0.5;

const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

export class ProjectLock {
  readonly #key: string;
  readonly #token: string;
  readonly #ttlMs: number;
  readonly #log: Logger;
  #timer: NodeJS.Timeout | null = null;
  #released = false;

  private constructor(key: string, token: string, ttlMs: number, log: Logger) {
    this.#key = key;
    this.#token = token;
    this.#ttlMs = ttlMs;
    this.#log = log;
    this.#startRenewal();
  }

  /**
   * Takes the lock, waiting up to `waitMs` for whoever holds it.
   *
   * Polling rather than a blocking primitive: Redis has no "wait for this key
   * to be deleted", and the alternative (a pub/sub notification on release)
   * adds a second failure mode to save a few hundred milliseconds on a path
   * that already takes seconds.
   */
  static async acquire(
    projectId: string,
    options: { ttlMs: number; waitMs: number; log: Logger },
  ): Promise<ProjectLock | null> {
    const key = REDIS_KEYS.projectLock(projectId);
    const token = randomUUID();
    const deadline = Date.now() + options.waitMs;
    const redis = getRedis();

    for (;;) {
      const taken = await redis.set(key, token, 'PX', options.ttlMs, 'NX');
      if (taken === 'OK') return new ProjectLock(key, token, options.ttlMs, options.log);
      if (Date.now() >= deadline) return null;
      await delay(Math.min(500, Math.max(50, deadline - Date.now())));
    }
  }

  /** Who currently holds a project's lock, for diagnostics. Null when free. */
  static async holder(projectId: string): Promise<string | null> {
    return getRedis().get(REDIS_KEYS.projectLock(projectId));
  }

  #startRenewal(): void {
    const every = Math.max(500, Math.floor(this.#ttlMs * RENEW_AT));
    this.#timer = setInterval(() => {
      void this.renew();
    }, every);
    // Never hold the event loop open for a lock renewal.
    this.#timer.unref();
  }

  /**
   * Extends the TTL, if we still own it.
   *
   * Losing it here is worth an error-level log: it means the deployment about
   * to go live is no longer the one holding the project, which is precisely the
   * situation the lock exists to prevent.
   */
  async renew(): Promise<boolean> {
    if (this.#released) return false;
    try {
      const result = await getRedis().eval(
        RENEW_SCRIPT,
        1,
        this.#key,
        this.#token,
        String(this.#ttlMs),
      );
      if (result === 1) return true;
      this.#log.error({ key: this.#key }, 'project lock was lost while still in use');
      return false;
    } catch (err) {
      this.#log.warn({ err, key: this.#key }, 'could not renew the project lock');
      return false;
    }
  }

  /** Releases it if we still own it. Never throws — it runs in a `finally`. */
  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    try {
      await getRedis().eval(RELEASE_SCRIPT, 1, this.#key, this.#token);
    } catch (err) {
      // The TTL is the backstop: an unreleased lock frees itself.
      this.#log.warn({ err, key: this.#key }, 'could not release the project lock');
    }
  }
}

/**
 * A short-lived, best-effort lock used to elect *one* worker for a periodic
 * job — today the container stats sampler.
 *
 * Different guarantees from `ProjectLock` on purpose: there is no renewal and
 * no ownership check on release, because nothing breaks if two workers sample
 * the same container in the same second. It only stops N replicas from each
 * polling the Docker API for every live container on every tick.
 */
export async function tryPeriodicLease(key: string, ttlMs: number): Promise<boolean> {
  try {
    return (await getRedis().set(key, '1', 'PX', ttlMs, 'NX')) === 'OK';
  } catch {
    // Redis is down; the sampler simply does not run this tick.
    return false;
  }
}
