/**
 * Stage: assets.
 *
 * Minifies the stylesheet, renders the HTML shell with the build's own stamps
 * substituted in, and computes a sha256 for every file in `dist/`. The digests
 * go into `build-info.json` and are served at `/api/build`, so "is the thing
 * running the thing I built?" is answerable from the browser — which is a
 * question a deployment platform demo should be able to answer.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { line, field, formatBytes, num, warn } from '../lib/log.mjs';

const PUBLIC_DIR = 'dist/public';

/**
 * A small, deliberate CSS minifier.
 *
 * Hand-written rather than pulling in a minifier dependency: the stylesheet is
 * ours, so the risky transforms a general-purpose tool must handle do not
 * arise, and a build stage whose behaviour is visible beats one more package.
 * Comments go, runs of whitespace collapse, and the space either side of the
 * structural punctuation goes.
 */
export function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>~+])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

/** Every file under `dir`, recursively, as paths relative to `dir`. */
async function walk(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, base)));
    else files.push(relative(base, full));
  }
  return files.sort();
}

export async function runAssets(buildInfoStub) {
  await mkdir(PUBLIC_DIR, { recursive: true });

  // --- stylesheet ----------------------------------------------------------
  const css = await readFile('src/ui/styles.css', 'utf8');
  const minified = minifyCss(css);
  await writeFile(join(PUBLIC_DIR, 'app.css'), minified, 'utf8');
  const saved = Buffer.byteLength(css) - Buffer.byteLength(minified);
  line(
    `styles.css ${formatBytes(Buffer.byteLength(css))} → app.css ${formatBytes(Buffer.byteLength(minified))} ` +
      `(saved ${formatBytes(saved)}, ${((saved / Buffer.byteLength(css)) * 100).toFixed(1)}%)`,
  );

  // --- html shell ----------------------------------------------------------
  // Substitution rather than a template engine: three placeholders do not
  // justify a dependency, and the failure mode of a missing one is visible.
  const html = await readFile('src/ui/index.html', 'utf8');
  const rendered = html
    .replaceAll('{{VERSION}}', buildInfoStub.version)
    .replaceAll('{{BUILT_AT}}', buildInfoStub.builtAt)
    .replaceAll('{{DEPLOYMENT}}', buildInfoStub.forge.deploymentId ?? 'local');
  const leftover = rendered.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) throw new Error(`unsubstituted placeholders in index.html: ${leftover.join(', ')}`);
  await writeFile(join(PUBLIC_DIR, 'index.html'), rendered, 'utf8');
  line(`index.html rendered (${formatBytes(Buffer.byteLength(rendered))}, 3 placeholders substituted)`);

  // --- digests -------------------------------------------------------------
  const files = await walk('dist');
  const assets = [];
  let total = 0;
  for (const file of files) {
    const bytes = await readFile(join('dist', file));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    assets.push({ file, bytes: bytes.length, sha256 });
    total += bytes.length;
    line(`  sha256 ${sha256.slice(0, 16)}…  ${formatBytes(bytes.length).padStart(10)}  ${file}`);
  }
  field('files in dist', num(assets.length));
  field('total size', formatBytes(total));

  // Source maps routinely outweigh the code they describe. Worth saying, since
  // every byte here is copied into the image and shipped.
  const mapBytes = assets
    .filter((asset) => asset.file.endsWith('.map'))
    .reduce((sum, asset) => sum + asset.bytes, 0);
  if (mapBytes > total - mapBytes) {
    warn(
      `source maps are ${formatBytes(mapBytes)} of the ${formatBytes(total)} artifact — ` +
        'set ANALYTICS_SOURCEMAP=false to ship without them',
    );
  }

  const dir = await stat('dist');
  if (!dir.isDirectory()) throw new Error('dist is not a directory');

  return { assets, total };
}
