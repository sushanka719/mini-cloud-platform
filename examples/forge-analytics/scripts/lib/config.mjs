/**
 * Build configuration.
 *
 * Every knob is an environment variable, because ForgeCloud injects the
 * project's env vars into the build — so the dashboard's "Environment" panel is
 * a working control for how heavy this build is. `ANALYTICS_SCALE` is the one
 * to reach for in a demo: it moves the dataset and the generated module count
 * together, which is what actually costs time.
 */

function int(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

function float(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

const scale = float('ANALYTICS_SCALE', 1, 0.05, 8);

export const config = {
  scale,
  /** Seed for the whole dataset. Change it and every number changes together. */
  seed: int('ANALYTICS_SEED', 20260908, 1, 2_147_483_647),
  /** Events synthesized and analyzed. The dominant cost of the dataset stage. */
  events: Math.max(50_000, Math.round(int('ANALYTICS_EVENTS', 3_000_000, 50_000, 20_000_000) * scale)),
  /** Generated TypeScript report modules. Drives the codegen and typecheck stages. */
  modules: Math.max(4, Math.round(int('ANALYTICS_MODULES', 96, 4, 400) * scale)),
  /** Re-run generation and compare checksums, proving the build is reproducible. */
  verifyDeterminism: (process.env.ANALYTICS_VERIFY ?? 'true') !== 'false',
  /** Countries given their own drill-down report. */
  drilldowns: int('ANALYTICS_DRILLDOWNS', 32, 0, 32),
  /** Routes given their own drill-down report. */
  routeDrilldowns: int('ANALYTICS_ROUTE_DRILLDOWNS', 24, 0, 24),
  /** Countries expanded into a full per-day matrix. Each one costs 90 more passes. */
  matrixCountries: int('ANALYTICS_MATRIX_COUNTRIES', 24, 0, 32),
  /** Rolling windows reported on, in days. */
  windows: [7, 30, 90],
  /** Minify the bundles. Off makes `dist/server.mjs` readable during a demo. */
  minify: (process.env.ANALYTICS_MINIFY ?? 'true') !== 'false',
  /** Emit .map files alongside the bundles. */
  sourcemap: (process.env.ANALYTICS_SOURCEMAP ?? 'true') !== 'false',
};

/** The FORGE_* variables the worker injects, echoed so the demo can see them land. */
export const forge = {
  deploymentId: process.env.FORGE_DEPLOYMENT_ID ?? null,
  projectId: process.env.FORGE_PROJECT_ID ?? null,
  orgId: process.env.FORGE_ORG_ID ?? null,
  workerId: process.env.FORGE_WORKER_ID ?? null,
  attempt: process.env.FORGE_ATTEMPT ?? null,
};
