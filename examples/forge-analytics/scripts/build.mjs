/**
 * forge-analytics build.
 *
 * Seven stages, run in order, each timed and announced. What ForgeCloud runs is
 * `npm run build`, which is this file — the platform's build step is a single
 * `spawn`, and everything below is the project's own business, which is exactly
 * how a real deployment platform sees a real project.
 *
 * The stages are ordered by dependency, not by cost:
 *
 *   preflight → codegen → dataset → typecheck → bundle → assets → manifest
 *
 * `codegen` must precede `typecheck` (it writes the modules being checked),
 * `dataset` must precede `bundle` (its JSON is inlined into the server bundle),
 * and `assets` must precede `manifest` (the manifest records their digests).
 *
 * Every stage does real work. Nothing here sleeps to look busy; if the build
 * takes a minute it is because a minute of analysis happened.
 */
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { config, forge } from './lib/config.mjs';
import { banner, done, field, formatMs, line, num, stage, warn } from './lib/log.mjs';
import { runCodegen } from './stages/codegen.mjs';
import { runDataset } from './stages/dataset.mjs';
import { runTypecheck } from './stages/typecheck.mjs';
import { runBundle } from './stages/bundle.mjs';
import { runAssets } from './stages/assets.mjs';

const TOTAL_STAGES = 7;

async function main() {
  const startedAt = Date.now();
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const stages = [];

  process.stdout.write(
    `forge-analytics ${pkg.version} — build starting\n` +
      `node ${process.version} on ${process.platform}/${process.arch}, ${String(process.env['NODE_ENV'] ?? 'development')}\n`,
  );

  // 1 ----------------------------------------------------------------------
  stages.push(
    await stage(1, TOTAL_STAGES, 'preflight', async () => {
      field('scale', config.scale);
      field('events', num(config.events));
      field('report modules', num(config.modules));
      field('country drill-downs', config.drilldowns);
      field('route drill-downs', config.routeDrilldowns);
      field('matrix countries', config.matrixCountries);
      field('minify', config.minify ? 'yes' : 'no');
      line('injected deployment environment:');
      for (const [key, value] of Object.entries(forge)) {
        field(`  FORGE_${key}`, value ?? '(not set)');
      }
      // Proves the project's own env vars arrive too — the dashboard's
      // Environment panel writes these.
      const projectVars = Object.keys(process.env)
        .filter((key) => key.startsWith('ANALYTICS_') || key === 'GREETING')
        .sort();
      field('project variables', projectVars.length > 0 ? projectVars.join(', ') : '(none set)');

      // Genuine advisories, on stderr so the dashboard's stream colouring has
      // something real to colour. Neither is fatal.
      if (process.env['NODE_ENV'] !== 'production') {
        warn(
          `NODE_ENV is ${JSON.stringify(process.env['NODE_ENV'] ?? '(unset)')}, not "production" — ` +
            'the bundle is still built for production, but dependencies were installed with dev deps included',
        );
      }
      if (config.scale !== 1) {
        warn(`ANALYTICS_SCALE=${config.scale} — this is not the default build size`);
      }

      // A clean dist every time: a stale file from a previous build would be
      // hashed into the manifest and shipped in the image.
      await rm('dist', { recursive: true, force: true });
      await mkdir('dist', { recursive: true });
      return 'workspace clean';
    }),
  );

  // 2 ----------------------------------------------------------------------
  let codegen;
  stages.push(
    await stage(2, TOTAL_STAGES, 'codegen', async () => {
      codegen = await runCodegen(config);
      return `${num(codegen.modules)} modules, ${num(codegen.bytes)} bytes of TypeScript`;
    }),
  );

  // 3 ----------------------------------------------------------------------
  let dataset;
  stages.push(
    await stage(3, TOTAL_STAGES, 'dataset', async () => {
      dataset = await runDataset(config);
      return `${num(dataset.events)} events → ${num(dataset.bytes)} bytes of precomputed reports`;
    }),
  );

  // 4 ----------------------------------------------------------------------
  stages.push(
    await stage(4, TOTAL_STAGES, 'typecheck', async () => {
      const result = await runTypecheck();
      return `${num(result.files)} files checked, 0 errors`;
    }),
  );

  // 5 ----------------------------------------------------------------------
  let bundle;
  stages.push(
    await stage(5, TOTAL_STAGES, 'bundle', async () => {
      bundle = await runBundle(config);
      return bundle.detail;
    }),
  );

  // 6 ----------------------------------------------------------------------
  // The stub carries what the HTML shell needs substituted; the full manifest
  // (with digests and stage timings) is written in stage 7.
  const stub = {
    app: pkg.name,
    version: pkg.version,
    builtAt: new Date().toISOString(),
    forge,
  };
  let assets;
  stages.push(
    await stage(6, TOTAL_STAGES, 'assets', async () => {
      assets = await runAssets(stub);
      return `${num(assets.assets.length)} files, ${num(assets.total)} bytes`;
    }),
  );

  // 7 ----------------------------------------------------------------------
  // Written twice on purpose. The first write is the stage's own work; the
  // second, after the stage has been timed, is the only way the manifest can
  // honestly report how long writing the manifest took. It is cheap (a few KB)
  // and it means the dashboard's stage chart accounts for the whole build
  // rather than quietly omitting its last step.
  let manifest = null;
  stages.push(
    await stage(7, TOTAL_STAGES, 'manifest', async () => {
      const info = {
        app: pkg.name,
        version: pkg.version,
        builtAt: stub.builtAt,
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        durationMs: Date.now() - startedAt,
        stages: stages.map((entry) => ({ title: entry.title, ms: entry.ms })),
        config: {
          seed: config.seed,
          events: config.events,
          modules: config.modules,
          scale: config.scale,
        },
        forge,
        checksum: dataset.checksum,
        assets: assets.assets,
      };
      manifest = info;
      await writeFile('dist/build-info.json', `${JSON.stringify(info, null, 2)}\n`, 'utf8');
      return 'dist/build-info.json';
    }),
  );

  // --- summary -------------------------------------------------------------
  const totalMs = Date.now() - startedAt;
  manifest.stages = stages.map((entry) => ({ title: entry.title, ms: entry.ms }));
  manifest.durationMs = totalMs;
  await writeFile('dist/build-info.json', `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  banner('✓', TOTAL_STAGES, 'summary');
  const slowest = Math.max(...stages.map((entry) => entry.ms));
  for (const entry of stages) {
    const width = Math.max(1, Math.round((entry.ms / slowest) * 34));
    line(
      `  ${entry.title.padEnd(11)} ${formatMs(entry.ms).padStart(8)}  ` +
        `${'█'.repeat(width)} ${String(Math.round((entry.ms / totalMs) * 100)).padStart(3)}%`,
    );
  }
  line('');
  field('total', formatMs(totalMs));
  field('dataset checksum', dataset.checksum);
  field('events analyzed', num(dataset.events));
  field('generated modules', num(codegen.modules));
  field('bundle output', `${num(bundle.bytes)} bytes across ${num(bundle.files)} files`);
  field('artifact files', num(assets.assets.length));
  done('build', totalMs, 'dist/ is ready to run with `npm start`');
}

main().catch((error) => {
  warn(`build failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
