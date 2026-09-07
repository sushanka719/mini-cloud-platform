/**
 * The sample app's "build": stamp the deployment metadata ForgeCloud injects
 * into a generated file and copy the server into dist/.
 *
 * It prints a few dozen lines so a demo has real streamed build output to
 * watch, and it reads FORGE_* / project env vars so the injected environment
 * is visibly working.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const started = Date.now();
console.log('hello-forge build starting');
console.log(`node ${process.version} on ${process.platform}/${process.arch}`);

const stamp = {
  builtAt: new Date().toISOString(),
  deploymentId: process.env.FORGE_DEPLOYMENT_ID ?? null,
  projectId: process.env.FORGE_PROJECT_ID ?? null,
  attempt: process.env.FORGE_ATTEMPT ?? null,
  greeting: process.env.GREETING ?? 'Hello from ForgeCloud',
  port: Number(process.env.PORT ?? 3000),
};

for (const [key, value] of Object.entries(stamp)) {
  console.log(`  ${key.padEnd(14)} ${String(value)}`);
}

// Some volume, so the log view has something to scroll.
const steps = ['resolve', 'transform', 'bundle', 'minify', 'emit'];
for (const step of steps) {
  for (let i = 1; i <= 8; i++) {
    console.log(`[${step}] chunk ${i}/8 ok`);
  }
}

// One line on stderr, so the dashboard's stream colouring has something to show.
console.error('warning: this is a demo build, nothing is actually bundled');

await mkdir('dist', { recursive: true });
await writeFile('dist/build-info.json', `${JSON.stringify(stamp, null, 2)}\n`);
await writeFile('dist/server.mjs', await readFile('server.mjs', 'utf8'));

console.log(`build complete in ${Date.now() - started}ms → dist/`);
