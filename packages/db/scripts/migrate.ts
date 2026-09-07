/**
 * Thin wrapper around node-pg-migrate so migrations always run against the same
 * DATABASE_URL the apps use (validated by @forge/config) and always resolve the
 * migrations dir from this package rather than the caller's cwd.
 *
 * Usage: pnpm --filter @forge/db migrate [up|down|redo|create <name>] [flags]
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { env } from '@forge/config';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const require = createRequire(import.meta.url);
// The ESM bin isn't an exported subpath, so resolve the package root first.
const binPath = resolve(
  dirname(require.resolve('node-pg-migrate/package.json')),
  'bin/node-pg-migrate.mjs',
);

const argv = process.argv.slice(2);
const action = argv[0] ?? 'up';
const rest = argv[0] ? argv.slice(1) : [];

const args = [
  binPath,
  '--tsx', // migrations are TypeScript
  '--migrations-dir',
  resolve(packageRoot, 'migrations'),
  '--migrations-table',
  'pgmigrations',
  action,
  ...rest,
];

// `create` is the only action that accepts a file language.
if (action === 'create') args.splice(args.indexOf(action), 0, '--migration-file-language', 'ts');

// shell:false + argv array — never interpolate into a shell (CLAUDE.md §8).
const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  cwd: packageRoot,
  env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
});

child.on('error', (err) => {
  process.stderr.write(`Failed to start node-pg-migrate: ${err.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
