/**
 * forge-analytics — the app ForgeCloud deploys.
 *
 * A plain `node:http` server on purpose: this is the *deployed workload* in a
 * deployment-platform demo, so the fewer moving parts of its own it has, the
 * more clearly it demonstrates the platform around it.
 *
 * Three behaviours matter to the demo:
 *
 *  1. **It listens last.** The socket is not opened until the warm-up has
 *     finished and the dataset checksum has been verified, so ForgeCloud's
 *     health check sees connection-refused and keeps polling rather than
 *     getting a 200 from a process that is not ready. The `health_check` stage
 *     therefore shows real elapsed time instead of passing instantly.
 *  2. **It narrates the warm-up on stdout.** Docker captures it, the worker
 *     follows the container log into the deployment log, and the browser sees
 *     the app boot in the same stream as the build.
 *  3. **It shuts down gracefully.** SIGTERM stops accepting connections, lets
 *     in-flight requests finish, and exits — which is what makes ForgeCloud's
 *     container swap clean instead of a killed process.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { loadConfig } from './lib/config';
import { AnalyticsStore } from './lib/store';
import { COUNTRIES, DEVICES, ROUTES, STATUSES } from './lib/synth.mjs';
import type { BuildInfo } from './lib/types';

const config = loadConfig();
const bootedAt = Date.now();

/**
 * Read from `dist/` at boot rather than imported into the bundle.
 *
 * It cannot be a bundled import: `build-info.json` carries the sha256 of every
 * file in `dist/` — including `dist/server.mjs` — so inlining it into the very
 * bundle it describes is circular. Reading it beside the bundle keeps the
 * digests honest.
 */
async function loadBuildInfo(): Promise<BuildInfo> {
  const raw = await readFile(new URL('./build-info.json', import.meta.url), 'utf8');
  return JSON.parse(raw) as BuildInfo;
}

function log(message: string): void {
  process.stdout.write(`[forge-analytics] ${message}\n`);
}

/** Static assets, read once at boot — the container's root filesystem is read-only. */
type StaticAsset = { body: Buffer; type: string };
const staticAssets = new Map<string, StaticAsset>();

async function loadStatic(): Promise<void> {
  const files: Array<[string, string, string]> = [
    ['/', './public/index.html', 'text/html; charset=utf-8'],
    ['/index.html', './public/index.html', 'text/html; charset=utf-8'],
    ['/app.css', './public/app.css', 'text/css; charset=utf-8'],
    ['/app.js', './public/app.js', 'application/javascript; charset=utf-8'],
  ];
  for (const [route, file, type] of files) {
    const body = await readFile(new URL(file, import.meta.url));
    staticAssets.set(route, { body, type });
  }
  log(`loaded ${String(staticAssets.size)} static assets`);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function intParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : Number.NaN;
}

function route(
  store: AnalyticsStore,
  info: BuildInfo,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const params = url.searchParams;

  const asset = staticAssets.get(path);
  if (asset && request.method === 'GET') {
    response.writeHead(200, {
      'content-type': asset.type,
      'content-length': asset.body.length,
      // The dashboard is redeployed constantly in a demo; a cached shell would
      // hide the very change being demonstrated.
      'cache-control': 'no-store',
    });
    response.end(asset.body);
    return;
  }

  switch (path) {
    case '/health':
    case '/healthz': {
      sendJson(response, 200, {
        ok: true,
        uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
        checksumVerified: store.stats.checksumVerified,
      });
      return;
    }
    case '/api/build': {
      sendJson(response, 200, info);
      return;
    }
    case '/api/stats': {
      const memory = process.memoryUsage();
      sendJson(response, 200, {
        ...store.stats,
        greeting: config.GREETING,
        deploymentId: config.FORGE_DEPLOYMENT_ID ?? null,
        projectId: config.FORGE_PROJECT_ID ?? null,
        attempt: config.FORGE_ATTEMPT ?? null,
        node: process.version,
        pid: process.pid,
        uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
        memory: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external,
          arrayBuffersBytes: memory.arrayBuffers,
        },
      });
      return;
    }
    case '/api/dimensions': {
      sendJson(response, 200, {
        routes: ROUTES,
        countries: COUNTRIES,
        devices: DEVICES,
        statuses: STATUSES,
        windows: store.windowKeys,
      });
      return;
    }
    case '/api/summary': {
      const key = params.get('window') ?? '90d';
      const slice = store.window(key);
      if (!slice) {
        sendJson(response, 404, { error: `unknown window ${key}`, available: store.windowKeys });
        return;
      }
      sendJson(response, 200, slice);
      return;
    }
    case '/api/reports': {
      sendJson(response, 200, { reports: store.reportList() });
      return;
    }
    case '/api/cohorts': {
      sendJson(response, 200, { cohorts: store.bundle.cohorts });
      return;
    }
    case '/api/funnel': {
      sendJson(response, 200, { funnel: store.bundle.funnel });
      return;
    }
    case '/api/sessions': {
      sendJson(response, 200, store.bundle.sessionStats);
      return;
    }
    case '/api/daily': {
      sendJson(response, 200, { daily: store.bundle.daily });
      return;
    }
    case '/api/hourly': {
      sendJson(response, 200, { hourly: store.bundle.hourly });
      return;
    }
    case '/api/weekly': {
      sendJson(response, 200, { weekly: store.bundle.weekly });
      return;
    }
    case '/api/countries': {
      sendJson(response, 200, { countries: store.bundle.drilldowns });
      return;
    }
    case '/api/routes': {
      sendJson(response, 200, { routes: store.bundle.routeDrilldowns });
      return;
    }
    case '/api/matrix': {
      sendJson(response, 200, { matrix: store.bundle.matrix });
      return;
    }
    case '/api/query': {
      const hour = intParam(params, 'hour');
      const fromDay = intParam(params, 'fromDay');
      const toDay = intParam(params, 'toDay');
      const startedAt = Date.now();
      const result = store.query({
        country: params.get('country') ?? undefined,
        route: params.get('route') ?? undefined,
        hour,
        fromDay,
        toDay,
      });
      if ('error' in result) {
        sendJson(response, 400, result);
        return;
      }
      sendJson(response, 200, { queryMs: Date.now() - startedAt, rollup: result });
      return;
    }
    default: {
      const match = /^\/api\/reports\/([A-Za-z0-9_-]+)$/.exec(path);
      if (match?.[1] !== undefined) {
        const windowKey = params.get('window');
        const report = store.report(match[1], windowKey ?? undefined);
        if (!report) {
          sendJson(response, 404, { error: `unknown report ${match[1]}` });
          return;
        }
        sendJson(response, 200, report);
        return;
      }
      sendJson(response, 404, { error: `no route for ${path}` });
    }
  }
}

async function main(): Promise<void> {
  log(`starting — node ${process.version} on ${process.platform}/${process.arch}`);
  const info = await loadBuildInfo();
  log(`build ${info.version} from ${info.builtAt} (deployment ${info.forge.deploymentId ?? 'local'})`);
  log(`build took ${String(info.durationMs)}ms across ${String(info.stages.length)} stages`);

  await loadStatic();
  const store = await AnalyticsStore.warmUp((message) => log(message), config.STRICT_CHECKSUM);

  if (config.STARTUP_DELAY_SECONDS > 0) {
    log(`STARTUP_DELAY_SECONDS=${String(config.STARTUP_DELAY_SECONDS)} — holding before listening`);
    await new Promise((resolve) => setTimeout(resolve, config.STARTUP_DELAY_SECONDS * 1000));
  }

  const server = createServer((request, response) => {
    const startedAt = Date.now();
    response.on('finish', () => {
      log(
        `${request.method ?? 'GET'} ${request.url ?? '/'} → ${String(response.statusCode)} ` +
          `${String(Date.now() - startedAt)}ms`,
      );
    });
    try {
      route(store, info, request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`request failed: ${message}`);
      if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
      else response.end();
    }
  });

  // Only now. Everything above had to succeed for this process to be worth
  // routing traffic to, and ForgeCloud's health check is watching this socket.
  server.listen(config.PORT, config.HOST, () => {
    log(`listening on http://${config.HOST}:${String(config.PORT)} — ready in ${String(Date.now() - bootedAt)}ms`);
  });

  /**
   * Graceful shutdown.
   *
   * ForgeCloud stops the previous container as part of every swap, and Docker
   * sends SIGTERM before SIGKILL. Closing the server lets in-flight requests
   * drain instead of being severed mid-response; the timer is the backstop for
   * a connection that will not close on its own.
   */
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received — draining connections`);
    const force = setTimeout(() => {
      log('drain timed out after 8s — exiting anyway');
      process.exit(0);
    }, 8000);
    force.unref();
    server.close(() => {
      log('closed cleanly');
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[forge-analytics] fatal: ${message}\n`);
  process.exit(1);
});
