import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { env, type Logger } from '@forge/config';
import { bodyMayStillBeUnsent, buildClientHeaders, buildUpstreamHeaders } from './headers.js';
import type { UpstreamPool } from './upstream-pool.js';

/**
 * Forwarding one HTTP request.
 *
 * Streams end to end, in both directions, with no buffering: an upload of
 * `MAX_UPLOAD_BYTES` passes through this function without the proxy ever
 * holding it, and a build-log download streams out of the API and into the
 * browser at the browser's pace. That is `pipe()` doing the backpressure
 * bookkeeping — the same property Phase 3 and Phase 6 rely on, one hop earlier.
 *
 * The awkward part is the retry. A connection that is *refused* has executed
 * nothing, so re-sending it to another replica is free — and it is the whole
 * point of a load balancer that killing a replica does not produce a visible
 * error. But we may only do that while the body is still un-sent, which means
 * not piping the client's request into the upstream until the socket is
 * actually connected. Hence `pipeWhenConnected` below.
 */

/** Response header naming the replica that served the request. */
export const UPSTREAM_HEADER = 'x-forge-upstream';

export type ForwardDeps = {
  pool: UpstreamPool;
  log: Logger;
};

export function forwardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ForwardDeps,
): void {
  attempt(request, response, deps, new Set());
}

function attempt(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ForwardDeps,
  tried: Set<string>,
): void {
  const upstream = deps.pool.next(tried);
  if (!upstream) {
    fail(response, 502, 'NO_UPSTREAM', 'No API replica could be reached.', deps.log, {
      tried: [...tried],
    });
    return;
  }
  tried.add(upstream.target);
  upstream.requests += 1;

  const headers = buildUpstreamHeaders(request, {
    remoteAddress: request.socket.remoteAddress ?? null,
    host: request.headers.host,
    port: env.PROXY_PORT,
    proto: 'http',
  });

  const upstreamRequest = httpRequest({
    host: upstream.host,
    port: upstream.port,
    method: request.method,
    path: request.url,
    headers,
    agent: upstream.agent,
  });

  /**
   * Only the *headers* are on a deadline. A long-running response (a streaming
   * log download) must not be cut off, so the timer is cleared as soon as the
   * upstream starts answering.
   */
  upstreamRequest.setTimeout(env.PROXY_UPSTREAM_TIMEOUT_MS, () => {
    upstreamRequest.destroy(
      new Error(`upstream did not respond within ${String(env.PROXY_UPSTREAM_TIMEOUT_MS)}ms`),
    );
  });

  upstreamRequest.on('response', (upstreamResponse: IncomingMessage) => {
    upstreamRequest.setTimeout(0);

    if (response.writableEnded || response.destroyed) {
      // The client gave up while we were waiting. Drain rather than destroy, so
      // the keep-alive socket goes back to the pool instead of being torn down.
      upstreamResponse.resume();
      return;
    }

    const clientHeaders = buildClientHeaders(upstreamResponse);
    // Which replica answered. The dashboard reads it to show the proxy
    // spreading load; a curl -i shows it during a demo.
    clientHeaders[UPSTREAM_HEADER] = upstream.target;
    // So a browser can read the header above cross-origin. The API's own CORS
    // plugin cannot know about it, and appending here beats teaching every
    // route about the proxy.
    exposeHeader(clientHeaders, UPSTREAM_HEADER);

    response.writeHead(upstreamResponse.statusCode ?? 502, clientHeaders);
    upstreamResponse.pipe(response);

    upstreamResponse.on('error', (err) => {
      deps.log.warn({ err, upstream: upstream.target }, 'upstream response stream failed');
      // Headers are already out, so there is no honest status left to send:
      // destroying the socket is what tells the client the body is truncated.
      response.destroy();
    });
  });

  upstreamRequest.on('error', (err: NodeJS.ErrnoException) => {
    deps.pool.markConnectError(upstream, err);

    if (response.headersSent) {
      response.destroy();
      return;
    }

    // Nothing was sent and there is another replica: this is the failover the
    // proxy exists for, and the client never learns it happened.
    if (bodyMayStillBeUnsent(request) && deps.pool.size > tried.size) {
      deps.log.warn(
        { err: err.message, upstream: upstream.target, method: request.method, url: request.url },
        'upstream unreachable; retrying on another replica',
      );
      attempt(request, response, deps, tried);
      return;
    }

    fail(
      response,
      502,
      'UPSTREAM_UNREACHABLE',
      'The API replica handling this request became unreachable.',
      deps.log,
      { upstream: upstream.target, error: err.message, retried: tried.size > 1 },
    );
  });

  // The client hung up mid-request. Abandon the upstream call rather than
  // letting it finish into a socket nobody is reading.
  request.on('aborted', () => {
    upstreamRequest.destroy();
  });

  pipeWhenConnected(request, upstreamRequest);
}

/**
 * Connects the client's body to the upstream request, but not before the TCP
 * connection exists.
 *
 * This is what keeps the retry above honest. `pipe()` immediately would start
 * reading the body, and a subsequent `ECONNREFUSED` would leave us holding a
 * half-consumed stream we cannot replay.
 *
 * A keep-alive agent complicates it: a *reused* socket is already connected and
 * will never emit `connect`, so waiting for that event unconditionally would
 * hang every request after the first. `socket.connecting` is the discriminator.
 */
function pipeWhenConnected(
  request: IncomingMessage,
  upstreamRequest: ReturnType<typeof httpRequest>,
): void {
  upstreamRequest.on('socket', (socket: Socket) => {
    if (socket.connecting) {
      socket.once('connect', () => {
        request.pipe(upstreamRequest);
      });
    } else {
      request.pipe(upstreamRequest);
    }
  });
}

/** Adds a name to `Access-Control-Expose-Headers` without dropping the API's. */
function exposeHeader(headers: Record<string, unknown>, name: string): void {
  const key =
    Object.keys(headers).find((k) => k.toLowerCase() === 'access-control-expose-headers') ??
    'access-control-expose-headers';
  const current = headers[key];
  const list = Array.isArray(current) ? current.join(', ') : typeof current === 'string' ? current : '';
  if (list.toLowerCase().includes(name)) return;
  headers[key] = list.length > 0 ? `${list}, ${name}` : name;
}

/**
 * The proxy's own error response.
 *
 * Shaped like the API's (`{ error: { code, message } }`) on purpose: the
 * dashboard's fetch wrapper parses that envelope, and a proxy that answered
 * with a bare string would surface as "Request failed" with no code — the one
 * failure mode this whole phase is meant to make visible.
 */
export function fail(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  log: Logger,
  context: Record<string, unknown> = {},
): void {
  log.error({ ...context, status, code }, message);
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = JSON.stringify({ error: { code, message } });
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}
