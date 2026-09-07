import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import { AppError, RATE_LIMIT_NAMESPACE, rateLimitIdentity } from '@forge/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getRateLimitRedis } from '../lib/redis.js';

/**
 * Counters live in Redis, not process memory, so the limit is a real limit
 * across API replicas rather than N× the intended rate (CLAUDE.md §4,
 * "multi-process shared state").
 *
 * Route-level overrides — much tighter on the auth endpoints — are attached in
 * the route files via `config.rateLimit`.
 */

/**
 * Key by authenticated identity when we have one, IP otherwise. Without this an
 * office behind one NAT would share a single bucket.
 */
function keyFor(request: FastifyRequest): string {
  const actor = request.actor;
  if (actor?.via === 'api_key') return rateLimitIdentity('key', actor.apiKeyId);
  if (actor) return rateLimitIdentity('user', actor.user.id);
  return rateLimitIdentity('ip', request.ip);
}

async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Its own connection, with ioredis's offline queue disabled: the limiter
    // fails open, so when Redis is down its INCR must fail *now* rather than
    // sit in the offline queue adding seconds to every request.
    redis: getRateLimitRedis(),
    // The store prepends this to both global and per-route buckets, so every
    // counter lands under the `rl:` namespace from CONVENTIONS §2.
    nameSpace: RATE_LIMIT_NAMESPACE,
    keyGenerator: keyFor,
    // If Redis is down, serve the request rather than locking everyone out.
    // The failure is visible in /health; a rate limiter should fail open.
    skipOnError: true,
    addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true },
    // Thrown, not sent — returning an AppError routes it through the one error
    // handler so a 429 has the same body shape as every other error.
    errorResponseBuilder: (_request, context) =>
      new AppError(
        'RATE_LIMITED',
        429,
        `Rate limit exceeded. Try again in ${String(context.after)}.`,
      ),
  });
}

export default fp(rateLimitPlugin, { name: 'rate-limit' });
