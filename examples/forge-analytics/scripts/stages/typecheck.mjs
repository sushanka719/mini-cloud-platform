/**
 * Stage: typecheck.
 *
 * `tsc --noEmit` over the hand-written sources *and* everything codegen just
 * produced. Run through `node node_modules/typescript/bin/tsc` rather than the
 * `tsc` bin shim: ForgeCloud's build environment is an explicit allowlist with
 * no shell, so depending on `node_modules/.bin` being on PATH is a needless
 * assumption. `process.execPath` is the node already running us.
 *
 * Its output is inherited straight through, so a type error appears in the
 * deployment log exactly as tsc wrote it — which is the whole value of running
 * it inside the pipeline rather than trusting the developer's machine.
 */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { line } from '../lib/log.mjs';

async function countTsFiles(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await countTsFiles(full);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mts')) total++;
  }
  return total;
}

export async function runTypecheck() {
  const files = await countTsFiles('src');
  line(`tsc --noEmit over ${files} TypeScript files (strict, noUncheckedIndexedAccess)`);

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) throw new Error(`tsc exited with code ${exitCode}`);
  line('no type errors');
  return { files };
}
