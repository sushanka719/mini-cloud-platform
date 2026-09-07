#!/usr/bin/env node
/**
 * Runs a ForgeCloud fleet on one laptop: N API replicas behind the proxy, M
 * workers competing for the queue, and the dashboard pointed at the proxy.
 *
 *   pnpm cluster                      # 2 api, 2 workers, proxy, dashboard
 *   pnpm cluster --api 3 --workers 3
 *   pnpm cluster --workers 3 --no-dashboard
 *
 * Why a script rather than more `concurrently` in package.json: the number of
 * replicas is a runtime choice, each one needs its own port and identity, and —
 * the actual reason — Phase 10's demo is *killing* one of them. So this keeps a
 * name to pid map and reads commands on stdin:
 *
 *   list                  what is running, with pids
 *   kill worker-2         SIGKILL — the crash demo. No cleanup, no goodbye.
 *   stop worker-2         SIGTERM — the graceful-shutdown demo. Drains first.
 *   start worker-2        bring a stopped one back
 *   quit                  SIGTERM everything and exit
 *
 * `kill` and `stop` are deliberately different words for deliberately different
 * demos. SIGTERM exercises the drain path: the worker stops taking jobs, aborts
 * its builds, records them as failed and unregisters, so the retry is immediate
 * and tidy. SIGKILL exercises the interesting one: nothing is recorded, the
 * heartbeat key expires on its own, and BullMQ's stalled-job recovery is what
 * hands the build to somebody else.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --- arguments --------------------------------------------------------------

function parseArgs(argv) {
  const options = { api: 2, workers: 2, proxy: true, dashboard: true, basePort: 4001 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const number = () => {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) fatal(`${arg} needs a non-negative integer`);
      return value;
    };
    switch (arg) {
      case '--api':
      case '-a':
        options.api = number();
        break;
      case '--workers':
      case '-w':
        options.workers = number();
        break;
      case '--base-port':
        options.basePort = number();
        break;
      case '--no-proxy':
        options.proxy = false;
        break;
      case '--no-dashboard':
        options.dashboard = false;
        break;
      case '--help':
      case '-h':
        usage();
        process.exit(0);
        break;
      default:
        fatal(`unknown argument ${arg}`);
    }
  }
  if (options.api === 0 && options.proxy) {
    fatal('--api 0 leaves the proxy nothing to forward to; add --no-proxy');
  }
  return options;
}

function usage() {
  process.stdout.write(
    [
      'Usage: pnpm cluster [--api N] [--workers M] [--base-port P] [--no-proxy] [--no-dashboard]',
      '',
      'Runtime commands on stdin: list | kill <name> | stop <name> | start <name> | quit',
      '',
    ].join('\n'),
  );
}

function fatal(message) {
  process.stderr.write(`cluster: ${message}\n`);
  process.exit(1);
}

// --- output -----------------------------------------------------------------

const ESC = '';
const COLORS = [`${ESC}[36m`, `${ESC}[33m`, `${ESC}[35m`, `${ESC}[32m`, `${ESC}[34m`, `${ESC}[95m`];
const RED = `${ESC}[31m`;
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const useColor = process.stdout.isTTY;

let width = 7;

function paint(color, text) {
  return useColor ? `${color}${text}${RESET}` : text;
}

/**
 * Prefixes every line with the process name.
 *
 * Line-buffered rather than chunk-buffered: pino-pretty writes a multi-line
 * record per log entry, and prefixing chunks instead of lines interleaves two
 * processes' output mid-record. The remainder is held until its newline
 * arrives — the same reason the build pipeline has a line splitter.
 */
function makePrefixer(name, color) {
  let pending = '';
  const label = () => paint(color, `${name.padEnd(width)} | `);
  return {
    write(chunk) {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(`${label()}${line}\n`);
    },
    flush() {
      if (pending.length > 0) {
        process.stdout.write(`${label()}${pending}\n`);
        pending = '';
      }
    },
  };
}

function note(message) {
  process.stdout.write(`${paint(DIM, `${'cluster'.padEnd(width)} | `)}${message}\n`);
}

// --- the fleet --------------------------------------------------------------

const options = parseArgs(process.argv.slice(2));

/** One managed process. `child` is null while it is stopped. */
class Managed {
  constructor(name, filter, env, color) {
    this.name = name;
    this.filter = filter;
    this.env = env;
    this.color = color;
    this.child = null;
    /** Set by a signal we sent, so the exit is not reported as a crash. */
    this.expected = false;
  }

  get running() {
    return this.child !== null;
  }

  start() {
    if (this.child) {
      note(`${this.name} is already running (pid ${String(this.child.pid)})`);
      return;
    }
    const out = makePrefixer(this.name, this.color);
    const child = spawn('pnpm', ['--filter', this.filter, 'dev'], {
      cwd: repoRoot,
      env: { ...process.env, ...this.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a signal aimed at this replica reaches its
      // whole tree (pnpm -> tsx -> node) rather than only the wrapper.
      detached: true,
    });
    this.child = child;
    child.stdout.on('data', (chunk) => out.write(chunk));
    child.stderr.on('data', (chunk) => out.write(chunk));
    child.on('exit', (code, signal) => {
      out.flush();
      this.child = null;
      const how = signal ? `signal ${signal}` : `code ${String(code)}`;
      note(
        this.expected
          ? `${this.name} exited (${how})`
          : `${paint(RED, `${this.name} exited unexpectedly`)} (${how})`,
      );
      this.expected = false;
      maybeExit();
    });
    child.on('error', (err) => {
      note(`${this.name} could not be started: ${err.message}`);
      this.child = null;
    });
    note(`${this.name} started (pid ${String(child.pid)})`);
  }

  /**
   * Signals the whole process group.
   *
   * `-pid` is the group, and it has to be: `pnpm --filter ... dev` spawns tsx,
   * which spawns node, and the process actually holding the port and the
   * heartbeat is that grandchild. Signalling the pnpm wrapper alone would leave
   * a live worker behind — which would make the crash demo silently not a crash
   * demo at all.
   */
  signal(name, expected) {
    if (!this.child?.pid) {
      note(`${this.name} is not running`);
      return;
    }
    this.expected = expected;
    try {
      process.kill(-this.child.pid, name);
    } catch {
      // The group is gone, or we lost the race with its own exit.
      try {
        this.child.kill(name);
      } catch {
        /* nothing left to signal */
      }
    }
  }
}

const managed = [];
const apiTargets = [];

for (let i = 1; i <= options.api; i++) {
  const port = options.basePort + i - 1;
  apiTargets.push(`127.0.0.1:${String(port)}`);
  managed.push(
    new Managed(
      `api-${String(i)}`,
      '@forge/api',
      { API_PORT: String(port), API_INSTANCE_ID: `api-${String(i)}` },
      COLORS[(i - 1) % COLORS.length],
    ),
  );
}

for (let i = 1; i <= options.workers; i++) {
  managed.push(
    new Managed(
      `worker-${String(i)}`,
      '@forge/worker',
      { WORKER_NAME: `worker-${String(i)}` },
      COLORS[(options.api + i - 1) % COLORS.length],
    ),
  );
}

const proxyPort = process.env.PROXY_PORT ?? '4100';
const proxyUrl = `http://localhost:${proxyPort}`;

if (options.proxy) {
  managed.push(
    new Managed(
      'proxy',
      '@forge/proxy',
      { PROXY_UPSTREAMS: apiTargets.join(','), PROXY_PORT: proxyPort },
      COLORS[(options.api + options.workers) % COLORS.length],
    ),
  );
}

if (options.dashboard) {
  managed.push(
    new Managed(
      'dashboard',
      '@forge/dashboard',
      {
        // The whole point: the dashboard talks to *one* address and has no idea
        // how many API processes are behind it. `next dev` reads NEXT_PUBLIC_*
        // at runtime, so this needs no rebuild.
        NEXT_PUBLIC_API_URL: options.proxy
          ? proxyUrl
          : `http://localhost:${String(options.basePort)}`,
      },
      COLORS[(options.api + options.workers + 1) % COLORS.length],
    ),
  );
}

width = Math.max(7, ...managed.map((process_) => process_.name.length));

function find(name) {
  const found = managed.find((process_) => process_.name === name);
  if (!found) note(`no such process "${name}" - try: list`);
  return found;
}

// --- lifecycle --------------------------------------------------------------

let quitting = false;

function maybeExit() {
  if (!quitting) return;
  if (managed.some((process_) => process_.running)) return;
  note('all processes stopped');
  process.exit(0);
}

function quit() {
  if (quitting) return;
  quitting = true;
  note('stopping the fleet (SIGTERM)...');
  for (const process_ of managed) {
    if (process_.running) process_.signal('SIGTERM', true);
  }
  // Every process here implements graceful shutdown with its own force-exit
  // timer; this is the backstop for one that ignores even that.
  setTimeout(() => {
    for (const process_ of managed) {
      if (process_.running) process_.signal('SIGKILL', true);
    }
    setTimeout(() => process.exit(1), 1_000).unref();
  }, 15_000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, quit);
}

// Packages must be compiled before the apps import them; `pnpm dev` does this
// too. Awaited rather than raced, because a worker that starts against a stale
// `@forge/shared` fails in a way that looks like a bug in this script.
note('building packages...');
await new Promise((done, rejectPromise) => {
  const build = spawn('pnpm', ['build:packages'], { cwd: repoRoot, stdio: 'inherit' });
  build.on('exit', (code) =>
    code === 0 ? done() : rejectPromise(new Error(`build:packages exited ${String(code)}`)),
  );
  build.on('error', rejectPromise);
});

note(
  `starting ${String(options.api)} api replica(s), ${String(options.workers)} worker(s)` +
    `${options.proxy ? `, proxy on ${proxyUrl}` : ''}` +
    `${options.dashboard ? ', dashboard on http://localhost:3000' : ''}`,
);
for (const process_ of managed) process_.start();

note('commands: list | kill <name> | stop <name> | start <name> | quit');

const stdin = createInterface({ input: process.stdin });
stdin.on('line', (line) => {
  const [command, target] = line.trim().split(/\s+/);
  switch (command) {
    case '':
    case undefined:
      break;
    case 'list':
      for (const process_ of managed) {
        note(
          `${process_.name.padEnd(width)} ${
            process_.running ? `running  pid ${String(process_.child.pid)}` : 'stopped'
          }`,
        );
      }
      break;
    case 'kill':
      // SIGKILL, to the group: this is the crash, so nothing gets a chance to
      // write "offline" anywhere.
      if (target) find(target)?.signal('SIGKILL', true);
      else note('kill needs a name - try: list');
      break;
    case 'stop':
      if (target) find(target)?.signal('SIGTERM', true);
      else note('stop needs a name - try: list');
      break;
    case 'start':
      if (target) find(target)?.start();
      else note('start needs a name - try: list');
      break;
    case 'quit':
    case 'exit':
      quit();
      break;
    default:
      note(`unknown command "${command}" - list | kill <name> | stop <name> | start <name> | quit`);
  }
});
// Piped or absent stdin must not end the fleet.
stdin.on('close', () => undefined);
