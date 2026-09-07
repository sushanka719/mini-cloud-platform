import { hostname } from 'node:os';
import fp from 'fastify-plugin';
import websocket from '@fastify/websocket';
import { env } from '@forge/config';
import { AppError, MAX_WS_CLIENT_FRAME_BYTES, WS_CLOSE, WS_HEARTBEAT_MS, WS_PATH, unauthorized } from '@forge/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ClientSocket } from '../realtime/client-socket.js';
import { configurePubSub, pubsubStats } from '../lib/pubsub.js';
import { readSession } from '../services/session-service.js';

/**
 * The WebSocket gateway (ROADMAP Phase 5, ARCHITECTURE §5).
 *
 * One socket per browser, many topics per socket, one Redis subscriber per
 * process. Nothing authoritative is held here — the set of live sockets is
 * per-process by definition, and every event on it came from Redis, which is
 * what lets a browser connect to *any* API replica and still see every
 * worker's output.
 */

/** Which API process this is; shown in the dashboard so fan-out is visible. */
export const API_INSTANCE = env.API_INSTANCE_ID ?? `${hostname()}-${String(process.pid)}`;

/**
 * A WebSocket handshake is **not** subject to CORS — the browser will happily
 * upgrade from any origin and send the session cookie with it. Without this
 * check any page the user visits could open a socket to localhost:4000 and
 * read their build logs (cross-site WebSocket hijacking), so the allowlist
 * that guards HTTP has to be applied by hand here.
 *
 * A missing Origin means a non-browser client (our own scripts, `ws` from
 * Node), which carries no ambient cookies and so isn't the threat this stops.
 */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  return env.CORS_ORIGIN.includes(origin);
}

async function realtimePlugin(app: FastifyInstance): Promise<void> {
  configurePubSub(app.log);

  const sockets = new Set<ClientSocket>();

  await app.register(websocket, {
    options: {
      // Client→server frames are control messages only; anything larger is
      // either a bug or an attempt to make us buffer.
      maxPayload: MAX_WS_CLIENT_FRAME_BYTES,
    },
    /**
     * Runs before the HTTP server stops accepting connections, so sockets are
     * told the API is going away instead of just dying (CLAUDE.md §4).
     */
    preClose: () => {
      for (const client of sockets) client.closeWith(WS_CLOSE.goingAway, 'server shutting down');
      sockets.clear();
    },
  });

  /**
   * Heartbeat. One timer for every socket rather than one per socket: a
   * per-socket interval would put N timers on the event loop for no benefit.
   *
   * The same tick re-validates session credentials. A socket can outlive the
   * session that opened it by days, so "logged out everywhere" has to reach
   * open sockets too — Redis is the authority, exactly as it is for REST.
   */
  const heartbeat = setInterval(() => {
    for (const client of sockets) {
      if (client.awaitingPong) {
        app.log.info({ socketId: client.id }, 'ws heartbeat timeout, dropping socket');
        sockets.delete(client);
        client.terminate();
        continue;
      }
      client.ping();
    }
    void revalidateAccess();
  }, WS_HEARTBEAT_MS);
  heartbeat.unref();

  /**
   * Two staleness problems, one pass:
   *   - the session that opened a socket can be revoked (logout, "log out
   *     everywhere", password change),
   *   - the membership that authorized a subscription can be removed.
   *
   * Neither is noticed by a socket that just sits there receiving, so both are
   * re-checked here against the authoritative stores.
   */
  async function revalidateAccess(): Promise<void> {
    // Set the first time a session check fails on the transport rather than on
    // the credential. Every remaining socket would fail the same way, so the
    // session half is skipped for the rest of the pass — but the subscription
    // half below reads Postgres and is unaffected, so it still runs. Bailing
    // out of the whole loop (as this did) meant one Redis blip also skipped
    // every socket's authorization refresh.
    let redisDown = false;

    for (const client of sockets) {
      const token = client.sessionToken;
      if (token && !redisDown) {
        let valid = true;
        try {
          valid = (await readSession(token)) !== null;
        } catch (err) {
          // Redis unreachable: keep the socket. Failing open here matches the
          // rate limiter, and /health reports the outage.
          app.log.warn({ err }, 'could not revalidate ws sessions');
          redisDown = true;
          valid = true;
        }
        if (!valid) {
          app.log.info({ socketId: client.id }, 'ws session revoked, closing socket');
          sockets.delete(client);
          client.closeWith(WS_CLOSE.unauthorized, 'session ended');
          continue;
        }
      }
      await client.revalidateSubscriptions();
    }
  }

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    for (const client of sockets) client.closeWith(WS_CLOSE.goingAway, 'server shutting down');
    sockets.clear();
  });

  app.get(
    WS_PATH,
    {
      websocket: true,
      // Connection floods are a denial-of-service vector even though nothing
      // is mutated (CLAUDE.md §8).
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      /**
       * Authentication happens on the handshake, before the upgrade: the
       * global auth hook has already resolved the cookie or bearer token into
       * `request.actor`, so this is the same one-line check as a REST route.
       *
       * The browser cannot set headers on a WebSocket, so it authenticates
       * with the session cookie — same-site here, since the dashboard and the
       * API differ only by port. Non-browser clients use `Authorization`.
       */
      preValidation: async (request: FastifyRequest) => {
        if (!originAllowed(request.headers.origin)) {
          request.log.warn(
            { origin: request.headers.origin },
            'ws handshake from a rejected origin',
          );
          throw new AppError('ORIGIN_NOT_ALLOWED', 403, 'Origin not allowed');
        }
        if (!request.actor) throw unauthorized();
      },
    },
    (socket, request) => {
      const actor = request.actor;
      if (!actor) {
        // Unreachable via preValidation; belt-and-braces so a hook change
        // can't silently open an unauthenticated socket.
        socket.close(WS_CLOSE.unauthorized, 'unauthorized');
        return;
      }

      const client = new ClientSocket(socket, actor, app.log, API_INSTANCE);
      sockets.add(client);
      request.log.info(
        { socketId: client.id, userId: actor.user.id, via: actor.via, sockets: sockets.size },
        'ws connected',
      );

      socket.on('message', (raw: Buffer) => client.onMessage(raw));
      socket.on('pong', () => {
        client.awaitingPong = false;
      });
      socket.on('error', (err: Error) => {
        request.log.warn({ err, socketId: client.id }, 'ws error');
      });
      socket.on('close', (code: number) => {
        sockets.delete(client);
        client.onClosed();
        request.log.info(
          { socketId: client.id, code, sockets: sockets.size },
          'ws disconnected',
        );
      });

      client.hello();
    },
  );

  /**
   * Gateway counters, for logging and the Phase 9 metrics endpoint. Per-process
   * by nature: with several API replicas each reports its own sockets.
   */
  app.decorate('realtimeStats', () => {
    let topics = 0;
    for (const client of sockets) topics += client.topicCount;
    return { instance: API_INSTANCE, sockets: sockets.size, topics, pubsub: pubsubStats() };
  });
}

export type RealtimeStats = {
  instance: string;
  sockets: number;
  topics: number;
  pubsub: { channels: number; listeners: number; connected: boolean };
};

declare module 'fastify' {
  interface FastifyInstance {
    realtimeStats: () => RealtimeStats;
  }
}

export default fp(realtimePlugin, { name: 'realtime', dependencies: ['auth', 'rate-limit'] });
