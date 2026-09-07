import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { env, type Logger } from '@forge/config';
import { buildUpstreamHeaders } from './headers.js';
import type { UpstreamPool } from './upstream-pool.js';

/**
 * Forwarding a WebSocket.
 *
 * An upgrade is not a request/response pair, so none of the HTTP path applies.
 * What actually happens:
 *
 *  1. the browser sends a normal GET carrying `Upgrade: websocket`;
 *  2. we replay that GET to a replica, keeping the upgrade headers this time —
 *     they are hop-by-hop, and this is the one hop where they *are* the point;
 *  3. the replica answers `101 Switching Protocols`, which Node surfaces as
 *     an `upgrade` event rather than a `response`;
 *  4. we write that 101 back to the browser verbatim and then get out of the
 *     way: the two sockets are piped together and every frame after this is
 *     bytes we never look at.
 *
 * Step 4 is why the proxy needs no WebSocket library and no framing code. It
 * also means the fan-out story is unchanged by putting a proxy in front of it:
 * a socket is pinned to whichever replica answered its upgrade, and events
 * reach it through Redis Pub/Sub — which is exactly why there is no sticky
 * routing to configure (ARCHITECTURE §7).
 *
 * The `head` argument is the one detail that bites: a client may send its first
 * frames in the same TCP segment as the upgrade request. Those bytes are
 * already off the socket and handed to us separately, so they have to be
 * written to the upstream before the pipe is established or the first message
 * of the connection silently disappears.
 */

export type UpgradeDeps = {
  pool: UpstreamPool;
  log: Logger;
};

export function forwardUpgrade(
  request: IncomingMessage,
  clientSocket: Socket,
  head: Buffer,
  deps: UpgradeDeps,
): void {
  const upstream = deps.pool.next();
  if (!upstream) {
    // No HTTP body to speak of at this point, but the client is still waiting
    // for a status line — so send a real one rather than dropping the socket.
    refuse(clientSocket, 502, 'No API replica could be reached.');
    return;
  }
  upstream.upgrades += 1;

  const headers = buildUpstreamHeaders(request, {
    remoteAddress: request.socket.remoteAddress ?? null,
    host: request.headers.host,
    port: env.PROXY_PORT,
    proto: 'http',
  });
  // `buildUpstreamHeaders` strips the hop-by-hop set, which for an upgrade
  // includes the two headers that make it an upgrade. Put them back, taken
  // from the client's own request rather than hard-coded, so a future
  // non-WebSocket upgrade passes through unchanged.
  restoreUpgradeHeaders(headers, request.headers);

  const upstreamRequest = httpRequest({
    host: upstream.host,
    port: upstream.port,
    method: request.method,
    path: request.url,
    headers,
    // No keep-alive agent: this socket is about to stop being HTTP altogether
    // and must never be returned to a pool for reuse.
    agent: false,
  });

  // Only the handshake is on a clock. Once the sockets are piped the connection
  // is expected to live for hours, and `PROXY_IDLE_TIMEOUT_MS` (applied to both
  // sockets below) is what bounds it after that.
  upstreamRequest.setTimeout(env.PROXY_HEALTH_TIMEOUT_MS + env.PROXY_UPSTREAM_TIMEOUT_MS, () => {
    upstreamRequest.destroy(new Error('upstream did not complete the websocket handshake'));
  });

  upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket: Socket, upstreamHead: Buffer) => {
    upstreamRequest.setTimeout(0);

    // The 101 goes back byte-for-byte apart from our own marker. Rewriting it
    // would risk breaking `Sec-WebSocket-Accept`, which is a hash the browser
    // verifies.
    const statusLine = [
      `HTTP/1.1 ${String(upstreamResponse.statusCode ?? 101)} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}`,
      ...Object.entries(upstreamResponse.headers).flatMap(([name, value]) =>
        Array.isArray(value)
          ? value.map((entry) => `${name}: ${entry}`)
          : value === undefined
            ? []
            : [`${name}: ${value}`],
      ),
      `x-forge-upstream: ${upstream.target}`,
      '',
      '',
    ].join('\r\n');

    clientSocket.write(statusLine);

    // Any bytes that arrived alongside the handshake, in both directions.
    if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);

    // WebSocket frames are latency-sensitive and small; Nagle would hold a
    // status update back waiting for company.
    clientSocket.setNoDelay(true);
    upstreamSocket.setNoDelay(true);
    clientSocket.setTimeout(env.PROXY_IDLE_TIMEOUT_MS);
    upstreamSocket.setTimeout(env.PROXY_IDLE_TIMEOUT_MS);

    const teardown = (reason: string, err?: unknown) => {
      if (err) deps.log.debug({ err, upstream: upstream.target, reason }, 'websocket closed');
      clientSocket.destroy();
      upstreamSocket.destroy();
    };

    clientSocket.on('error', (err) => teardown('client error', err));
    upstreamSocket.on('error', (err) => teardown('upstream error', err));
    // A half-closed proxied socket is not useful to anyone: the gateway's
    // ping/pong keeps a live connection warm, so silence this long means the
    // peer is gone.
    clientSocket.on('timeout', () => teardown('client idle timeout'));
    upstreamSocket.on('timeout', () => teardown('upstream idle timeout'));
    // Either side closing ends the other. Without this the replica keeps a
    // socket (and its topic subscriptions) for a browser tab that is gone.
    clientSocket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => clientSocket.destroy());

    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);

    deps.log.debug({ upstream: upstream.target, url: request.url }, 'websocket proxied');
  });

  // The replica answered the upgrade with a normal response — an auth failure,
  // most likely (the gateway rejects an unauthenticated socket). Relay it, or
  // the browser sees an unexplained closed connection.
  upstreamRequest.on('response', (upstreamResponse: IncomingMessage) => {
    upstreamRequest.setTimeout(0);
    refuse(
      clientSocket,
      upstreamResponse.statusCode ?? 502,
      'The API refused the websocket upgrade.',
    );
    upstreamResponse.resume();
  });

  upstreamRequest.on('error', (err) => {
    deps.pool.markConnectError(upstream, err);
    deps.log.warn({ err, upstream: upstream.target }, 'websocket upgrade failed');
    // Deliberately not retried on another replica. A retry means a second
    // handshake with the same `Sec-WebSocket-Key`, and the browser reconnects
    // on its own with backoff (Phase 5's client does exactly that) — which is
    // both simpler and the behaviour the dashboard is already built around.
    refuse(clientSocket, 502, 'No API replica accepted the websocket upgrade.');
  });

  clientSocket.on('error', () => {
    upstreamRequest.destroy();
  });

  upstreamRequest.end();
}

/** Restores the upgrade handshake headers `buildUpstreamHeaders` had to strip. */
function restoreUpgradeHeaders(target: IncomingHttpHeaders, source: IncomingHttpHeaders): void {
  for (const name of ['connection', 'upgrade'] as const) {
    const value = source[name];
    if (value !== undefined) target[name] = value;
  }
}

/** A status line for a socket that never became a WebSocket. */
function refuse(socket: Socket, status: number, message: string): void {
  if (socket.destroyed || socket.writableEnded) return;
  socket.write(
    `HTTP/1.1 ${String(status)} ${message}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
  );
  socket.destroy();
}
