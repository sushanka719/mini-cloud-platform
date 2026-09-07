import { env } from '@forge/config';
import { closeDb } from '@forge/db';
import { closeCompressionPool } from '@forge/storage';
import { closeQueue } from '@forge/queue';
import { buildApp } from './app.js';
import { closePubSub } from './lib/pubsub.js';
import { closeRedis, connectRedis } from './lib/redis.js';

const app = await buildApp();

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests finish,
 * then close DB/Redis handles. A hard timer guarantees we still exit if a
 * handle refuses to close (CLAUDE.md §4).
 */
let shuttingDown = false;

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ reason }, 'shutting down');

  const forceExit = setTimeout(() => {
    app.log.error({ timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, 'graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await app.close(); // drains in-flight HTTP requests
    // The compression pool goes first: it waits for any in-flight gzip to
    // finish before terminating its threads, and those threads only touch the
    // filesystem, not the handles closed below.
    await closeCompressionPool();
    // closeQueue() shuts the BullMQ producer and its own Redis connection;
    // closeRedis() owns the API's command/publisher/rate-limit connections and
    // closePubSub() the WebSocket gateway's subscriber. app.close() above has
    // already closed the sockets themselves via the plugin's preClose hook.
    await Promise.allSettled([closeQueue(), closePubSub(), closeDb(), closeRedis()]);
    app.log.info('shutdown complete');
    clearTimeout(forceExit);
    process.exit(exitCode);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'unhandled rejection');
  void shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (err) => {
  app.log.fatal({ err }, 'uncaught exception');
  void shutdown('uncaughtException', 1);
});

// Connect Redis up front so a misconfigured URL fails at boot, not on first use.
try {
  await connectRedis();
} catch (err) {
  app.log.error({ err }, 'redis not reachable at startup — /health will report it');
}

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  app.log.info(
    { host: env.API_HOST, port: env.API_PORT, env: env.NODE_ENV },
    'forgecloud api listening',
  );
} catch (err) {
  app.log.fatal({ err }, 'failed to start api');
  process.exit(1);
}
