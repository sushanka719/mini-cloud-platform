import type { IncomingMessage, ServerResponse } from 'node:http';
import { env } from '@forge/config';
import type { UpstreamPool } from './upstream-pool.js';

/**
 * `GET /__forge/proxy` — the proxy's own view of itself.
 *
 * The only endpoint the proxy serves rather than forwards, and it exists
 * because the round-robin is otherwise invisible: the numbers that prove the
 * fan-out is real (how many requests went where, which replica is out of
 * rotation and why) live in *this* process and nowhere else. An API replica
 * cannot report them — it does not know it is behind a proxy.
 *
 * Deliberately unauthenticated, and deliberately thin because of that. It
 * exposes what the fleet page already shows any authenticated member (hostnames
 * and ports of local replicas) and no request contents, no headers, no paths.
 * The proxy holds no credentials and cannot check one: session tokens live in
 * Redis, which the proxy has no connection to, and adding one so it could
 * authenticate its own status page would give it a reason to hold state — the
 * one thing a load balancer should not do.
 *
 * The path is namespaced under `/__forge/` so it cannot collide with an API
 * route. Anything else under that prefix is a 404 from the proxy rather than a
 * request forwarded to a replica that would 404 it anyway.
 */

export const PROXY_STATUS_PATH = '/__forge/proxy';
const PROXY_NAMESPACE = '/__forge/';

export function isProxyOwnPath(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split('?')[0] ?? '';
  return path === PROXY_STATUS_PATH || path.startsWith(PROXY_NAMESPACE);
}

export function handleProxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pool: UpstreamPool,
  startedAt: number,
): void {
  // The dashboard fetches this from another origin with the same client that
  // talks to the API, so it needs the same CORS treatment — echoed origin (not
  // `*`) because that client sends credentials on every request.
  applyCors(request, response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'access-control-allow-methods': 'GET, OPTIONS' });
    response.end();
    return;
  }

  const path = (request.url ?? '').split('?')[0] ?? '';
  if (path !== PROXY_STATUS_PATH || (request.method !== 'GET' && request.method !== 'HEAD')) {
    const body = JSON.stringify({
      error: { code: 'NOT_FOUND', message: `No proxy route for ${request.method ?? '?'} ${path}` },
    });
    response.writeHead(404, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    response.end(request.method === 'HEAD' ? undefined : body);
    return;
  }

  const upstreams = pool.all.map((upstream) => ({
    target: upstream.target,
    healthy: upstream.healthy,
    requests: upstream.requests,
    upgrades: upstream.upgrades,
    connectErrors: upstream.connectErrors,
    lastProbeMs: upstream.lastProbeMs,
    lastError: upstream.lastError,
  }));

  const body = JSON.stringify({
    ok: true,
    port: env.PROXY_PORT,
    uptimeMs: Date.now() - startedAt,
    healthPath: env.PROXY_HEALTH_PATH,
    upstreams,
    healthy: upstreams.filter((u) => u.healthy).length,
    total: upstreams.length,
    /** Total routed, so a client can compute the split without summing itself. */
    requests: upstreams.reduce((sum, u) => sum + u.requests, 0),
    upgrades: upstreams.reduce((sum, u) => sum + u.upgrades, 0),
    at: new Date().toISOString(),
  });

  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // A snapshot of live counters must never be cached.
    'cache-control': 'no-store',
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

function applyCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !env.CORS_ORIGIN.includes(origin)) return;
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-credentials', 'true');
  response.setHeader('vary', 'origin');
}
