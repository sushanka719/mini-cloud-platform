import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { createLogger, env } from '@forge/config';
import { UpstreamPool, configuredTargets } from './upstream-pool.js';
import { forwardRequest } from './forward.js';
import { forwardUpgrade } from './upgrade.js';
import { handleProxyRequest, isProxyOwnPath } from './status.js';

/**
 * The ForgeCloud reverse proxy — one port in front of N API replicas.
 *
 * Phase 10's job is to prove the architecture is horizontal on one laptop, and
 * this is the piece that makes it *usable* rather than merely true: the
 * dashboard points at one address and does not know or care how many API
 * processes are behind it. Nothing here is stateful, because nothing can be —
 * sessions are opaque tokens in Redis, so any replica can serve any request and
 * there is no sticky routing to configure. Killing a replica mid-demo costs the
 * requests already in flight on it and nothing else.
 *
 * Caddy or Nginx would do this in ten lines of config, and that is exactly why
 * it is hand-written: `http.request` + `pipe` + the `upgrade` event *are* the
 * learning goal (CLAUDE.md §4), and the parts a config file hides — hop-by-hop
 * headers, when a retry is safe, what happens to the bytes that arrive with a
 * WebSocket handshake — are the parts worth writing out.
 */
const log = createLogger('proxy', { base: { service: 'proxy', pid: process.pid } });
const startedAt = Date.now();

const pool = new UpstreamPool(configuredTargets(), log);
pool.start();

/** Every live client socket, so shutdown can end the ones that are idle. */
const sockets = new Set<Socket>();

const server = createServer((request, response) => {
  if (isProxyOwnPath(request.url)) {
    handleProxyRequest(request, response, pool, startedAt);
    return;
  }
  forwardRequest(request, response, { pool, log });
});

server.on('upgrade', (request, socket, head) => {
  forwardUpgrade(request, socket as Socket, head, { pool, log });
});

server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

/**
 * Node's own header/request timeouts, set explicitly rather than left at their
 * defaults: `requestTimeout` defaults to 5 minutes, and a proxy that holds a
 * half-sent request that long is a slowloris amplifier.
 */
server.headersTimeout = 30_000;
server.requestTimeout = env.PROXY_UPSTREAM_TIMEOUT_MS;
// Above the WebSocket ping interval, or a live socket would be culled between
// two frames. The upgrade path replaces this with PROXY_IDLE_TIMEOUT_MS anyway.
server.keepAliveTimeout = 65_000;

let shuttingDown = false;

/**
 * Graceful shutdown (CLAUDE.md §4): stop accepting connections, let in-flight
 * requests finish, then close what is left. `closeIdleConnections()` is the
 * important call — without it a keep-alive socket with no request on it keeps
 * `server.close()` waiting for its full timeout.
 */
async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ reason, sockets: sockets.size }, 'shutting down');

  const forceExit = setTimeout(() => {
    log.error({ timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, 'graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  pool.stop();
  server.closeIdleConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  // Anything still open is a proxied WebSocket, which by design never ends on
  // its own. They are closed here; the dashboard reconnects.
  for (const socket of sockets) socket.destroy();

  log.info('shutdown complete');
  clearTimeout(forceExit);
  process.exit(exitCode);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

process.on('unhandledRejection', (reason) => {
  log.fatal({ err: reason }, 'unhandled rejection');
  void shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception');
  void shutdown('uncaughtException', 1);
});

server.on('error', (err) => {
  log.fatal({ err }, 'proxy server error');
  void shutdown('serverError', 1);
});

server.listen(env.PROXY_PORT, env.PROXY_HOST, () => {
  log.info(
    {
      host: env.PROXY_HOST,
      port: env.PROXY_PORT,
      upstreams: pool.all.map((u) => u.target),
      healthPath: env.PROXY_HEALTH_PATH,
    },
    'forgecloud proxy listening',
  );
});
