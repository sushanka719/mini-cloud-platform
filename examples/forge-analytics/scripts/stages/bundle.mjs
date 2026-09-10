/**
 * Stage: bundle.
 *
 * esbuild, through its JS API rather than its CLI — the API hands back metafile
 * output, which is what lets the build print where the bytes actually went
 * instead of just "done". Two entry points: the server (Node, ESM, external
 * built-ins) and the browser bundle the dashboard loads.
 *
 * The generated `reports.json` is inlined into the server bundle rather than
 * read from disk at runtime. The container's root filesystem is read-only and
 * its working directory is not guaranteed to be what the build assumed, so a
 * self-contained `dist/server.mjs` is one less thing to get wrong.
 */
import { build } from 'esbuild';
import { line, field, formatBytes, formatMs, warn } from '../lib/log.mjs';

/** Reports every output file esbuild produced, largest first. */
function reportOutputs(metafile) {
  const outputs = Object.entries(metafile.outputs).sort((a, b) => b[1].bytes - a[1].bytes);
  let total = 0;
  for (const [file, meta] of outputs) {
    total += meta.bytes;
    line(`  ${file.padEnd(30)} ${formatBytes(meta.bytes).padStart(10)}`);
  }
  return { files: outputs.length, total };
}

/** The five heaviest modules in a bundle — the question anyone actually asks. */
function reportHeaviest(metafile, limit = 5) {
  const inputs = [];
  for (const output of Object.values(metafile.outputs)) {
    for (const [file, meta] of Object.entries(output.inputs)) {
      inputs.push({ file, bytes: meta.bytesInOutput });
    }
  }
  inputs.sort((a, b) => b.bytes - a.bytes);
  for (const input of inputs.slice(0, limit)) {
    line(`  heaviest  ${input.file.padEnd(44)} ${formatBytes(input.bytes).padStart(10)}`);
  }
}

export async function runBundle(config) {
  const t0 = Date.now();

  line('bundling server (platform=node, format=esm, target=node20)');
  const server = await build({
    entryPoints: ['src/server.ts'],
    outfile: 'dist/server.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // Node built-ins stay external; everything else — including the generated
    // report modules and reports.json — is inlined.
    packages: 'bundle',
    external: ['node:*'],
    minify: config.minify,
    sourcemap: config.sourcemap ? 'linked' : false,
    metafile: true,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: {
      js: '// forge-analytics — bundled by esbuild. Generated file; edit src/ instead.',
    },
  });
  for (const message of server.warnings) warn(`esbuild: ${message.text}`);
  const serverOut = reportOutputs(server.metafile);
  reportHeaviest(server.metafile);

  line('bundling browser client (platform=browser, format=iife, target=es2020)');
  const client = await build({
    entryPoints: ['src/ui/client.ts'],
    outfile: 'dist/public/app.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    minify: config.minify,
    sourcemap: config.sourcemap ? 'linked' : false,
    metafile: true,
    logLevel: 'silent',
  });
  for (const message of client.warnings) warn(`esbuild: ${message.text}`);
  const clientOut = reportOutputs(client.metafile);

  const modules =
    Object.keys(server.metafile.inputs).length + Object.keys(client.metafile.inputs).length;
  field('modules bundled', modules);
  field('total output', formatBytes(serverOut.total + clientOut.total));
  field('minified', config.minify ? 'yes' : 'no');

  return {
    bytes: serverOut.total + clientOut.total,
    files: serverOut.files + clientOut.files,
    modules,
    ms: Date.now() - t0,
    detail: `${modules} modules → ${formatBytes(serverOut.total + clientOut.total)} in ${formatMs(Date.now() - t0)}`,
  };
}
