/**
 * Stage: dataset.
 *
 * Synthesizes the event corpus and runs every analysis the dashboard shows.
 * This is the stage that costs real CPU, and all of it is honest work — no
 * sleeps, no busy-waiting. What makes it expensive is breadth: the corpus is
 * walked once for the headline rollup, once per rolling window, once per day,
 * once per country drill-down, and then the whole thing is regenerated from
 * the seed to prove the build is reproducible.
 *
 * The output is split into a recomputable half (which the server checks itself
 * against at boot) and a build-only half (too slow to repeat in a container).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { line, progress, field, num, formatMs, formatBytes, warn } from '../lib/log.mjs';
import {
  COUNTRIES,
  DAYS,
  ROUTES,
  WEEK_MS,
  DAY_MS,
  EPOCH_START,
  checksum,
  cohorts,
  funnel,
  generateEvents,
  rollup,
  sessionize,
  shapeFor,
  windowRollup,
} from '../../src/lib/synth.mjs';

const GENERATED = 'src/generated';

/** Totals + worst routes, which is all a drill-down needs to be useful. */
function toDrilldown(key, label, slice) {
  const topRoutes = slice.byRoute
    .filter((route) => route.requests > 0)
    .slice(0, 3)
    .map((route) => ({ path: route.path, requests: route.requests, errorRate: route.errorRate }));
  return { key, label, totals: slice.totals, topRoutes };
}

export async function runDataset(config) {
  const shape = shapeFor(config.events);
  field('seed', config.seed);
  field('events', num(config.events));
  field('users (derived)', num(shape.users));
  field('sessions (derived)', num(shape.sessions));
  field('corpus span', `${DAYS} days from ${new Date(EPOCH_START).toISOString().slice(0, 10)}`);

  // --- synthesize ----------------------------------------------------------
  line('synthesizing event corpus');
  const t0 = Date.now();
  const events = generateEvents(config.seed, config.events, (current, total) => {
    progress('generate', current, total);
  });
  const genMs = Date.now() - t0;
  const bytesInMemory =
    events.count * (8 + 1 + 1 + 1 + 1 + 2 + 4 + 4 + 4) + events.sessionCount * 12;
  line(`generated ${num(events.count)} events in ${formatMs(genMs)} (${formatBytes(bytesInMemory)} resident)`);

  // The server regenerates this same corpus at boot, inside a container with a
  // hard memory cap. Better to say so at build time than to be OOM-killed
  // during a health check.
  const CONTAINER_BUDGET_BYTES = 512 * 1024 * 1024;
  const projectedRss = bytesInMemory + 110 * 1024 * 1024;
  if (projectedRss > CONTAINER_BUDGET_BYTES * 0.6) {
    warn(
      `projected runtime footprint ${formatBytes(projectedRss)} is over 60% of a 512MB container — ` +
        'lower ANALYTICS_EVENTS or raise DOCKER_MEMORY_MB before deploying this',
    );
  }

  // --- rolling windows -----------------------------------------------------
  line(`rolling windows: ${config.windows.map((d) => `${d}d`).join(', ')}`);
  const windows = {};
  for (const days of config.windows) {
    const t = Date.now();
    const slice = windowRollup(events, days);
    windows[`${days}d`] = slice;
    line(
      `  ${`${days}d`.padEnd(5)} ${num(slice.totals.requests).padStart(11)} requests  ` +
        `${(slice.totals.errorRate * 100).toFixed(2).padStart(5)}% errors  ` +
        `p95 ${String(slice.totals.p95Ms).padStart(5)}ms  (${formatMs(Date.now() - t)})`,
    );
  }

  const headline = windows[`${DAYS}d`] ?? windowRollup(events, DAYS);

  // --- behavioural analysis ------------------------------------------------
  line('sessionizing (sort by user, 30-minute inactivity gap)');
  const tSession = Date.now();
  const sessionStats = sessionize(events, undefined, (current, total, phase) => {
    progress(phase ?? 'sessionize', current, total);
  });
  line(
    `  ${num(sessionStats.sessions)} sessions, ${(sessionStats.bounceRate * 100).toFixed(1)}% bounced, ` +
      `${sessionStats.avgEventsPerSession} events/session, ${sessionStats.avgSessionSeconds}s average ` +
      `(${formatMs(Date.now() - tSession)})`,
  );

  line('weekly cohort retention');
  const tCohort = Date.now();
  const cohortMatrix = cohorts(events, (current, total, phase) => {
    progress(phase ?? 'cohorts', current, total);
  });
  const firstCohort = cohortMatrix[0];
  if (firstCohort) {
    line(
      `  cohort ${firstCohort.cohort}: ${num(firstCohort.users)} users, ` +
        `retention ${firstCohort.retention.slice(0, 6).map((r) => `${Math.round(r * 100)}%`).join(' → ')} ` +
        `(${formatMs(Date.now() - tCohort)})`,
    );
  }

  line(`funnel analysis`);
  const tFunnel = Date.now();
  const funnelRows = funnel(events, (current, total, phase) => {
    progress(phase ?? 'funnel', current, total);
  });
  for (const step of funnelRows) {
    line(
      `  ${String(step.stage)}. ${step.path.padEnd(12)} ${num(step.users).padStart(9)} users  ` +
        `${(step.conversionFromPrevious * 100).toFixed(1).padStart(5)}% from previous`,
    );
  }
  line(`  funnel complete (${formatMs(Date.now() - tFunnel)})`);

  // --- per-day breakdown ---------------------------------------------------
  // 90 filtered passes over the corpus. Precomputed here precisely because it
  // is too expensive to repeat at container start.
  line(`per-day breakdown (${DAYS} filtered rollups)`);
  const tDaily = Date.now();
  const daily = [];
  for (let d = 0; d < DAYS; d++) {
    const from = EPOCH_START + d * DAY_MS;
    const date = new Date(from).toISOString().slice(0, 10);
    const slice = rollup(events, { fromMs: from, toMs: from + DAY_MS, label: date });
    daily.push(toDrilldown(date, date, slice));
    if ((d + 1) % 15 === 0 || d === DAYS - 1) progress('days', d + 1, DAYS);
  }
  const worstDay = daily.reduce((a, b) => (b.totals.errorRate > a.totals.errorRate ? b : a));
  line(
    `  worst day ${worstDay.key}: ${(worstDay.totals.errorRate * 100).toFixed(2)}% errors ` +
      `over ${num(worstDay.totals.requests)} requests (${formatMs(Date.now() - tDaily)})`,
  );

  // --- hour-of-day profile -------------------------------------------------
  line('hour-of-day profile (24 filtered rollups)');
  const tHourly = Date.now();
  const hourly = [];
  for (let h = 0; h < 24; h++) {
    const label = `${String(h).padStart(2, '0')}:00`;
    hourly.push(toDrilldown(label, label, rollup(events, { hour: h, label })));
    if ((h + 1) % 6 === 0) progress('hours', h + 1, 24);
  }
  const peakHour = hourly.reduce((a, b) => (b.totals.requests > a.totals.requests ? b : a));
  line(
    `  peak hour ${peakHour.key} with ${num(peakHour.totals.requests)} requests ` +
      `(${formatMs(Date.now() - tHourly)})`,
  );

  // --- weekly rollups ------------------------------------------------------
  const weekCount = Math.ceil(DAYS / 7);
  line(`weekly rollups (${weekCount} filtered rollups)`);
  const tWeekly = Date.now();
  const weekly = [];
  for (let w = 0; w < weekCount; w++) {
    const from = EPOCH_START + w * WEEK_MS;
    const label = `week ${w + 1}`;
    weekly.push(toDrilldown(label, label, rollup(events, { fromMs: from, toMs: from + WEEK_MS, label })));
  }
  line(`  ${weekCount} weeks summarized (${formatMs(Date.now() - tWeekly)})`);

  // --- per-country drill-downs --------------------------------------------
  const topCountries = headline.byCountry.slice(0, config.drilldowns);
  const drilldowns = [];
  if (topCountries.length > 0) {
    line(`per-country drill-downs (top ${topCountries.length} of ${COUNTRIES.length})`);
    const tDrill = Date.now();
    for (const country of topCountries) {
      const index = COUNTRIES.indexOf(country.code);
      const slice = rollup(events, { country: index, label: `country:${country.code}` });
      drilldowns.push(toDrilldown(country.code, `Country ${country.code}`, slice));
      if (drilldowns.length % 8 === 0) progress('countries', drilldowns.length, topCountries.length);
    }
    const worst = drilldowns.reduce((a, b) => (b.totals.errorRate > a.totals.errorRate ? b : a));
    line(
      `  worst country ${worst.key} at ${(worst.totals.errorRate * 100).toFixed(2)}% errors ` +
        `(${formatMs(Date.now() - tDrill)})`,
    );
  }

  // --- per-route drill-downs ----------------------------------------------
  const topRoutes = headline.byRoute.slice(0, config.routeDrilldowns);
  const routeDrilldowns = [];
  if (topRoutes.length > 0) {
    line(`per-route drill-downs (top ${topRoutes.length} of ${ROUTES.length})`);
    const tRoutes = Date.now();
    for (const route of topRoutes) {
      const index = ROUTES.indexOf(route.path);
      const slice = rollup(events, { route: index, label: `route:${route.path}` });
      routeDrilldowns.push(toDrilldown(route.path, route.path, slice));
      if (routeDrilldowns.length % 8 === 0) progress('routes', routeDrilldowns.length, topRoutes.length);
    }
    const slowest = routeDrilldowns.reduce((a, b) => (b.totals.p99Ms > a.totals.p99Ms ? b : a));
    line(
      `  slowest route ${slowest.key} at p99 ${slowest.totals.p99Ms}ms ` +
        `(${formatMs(Date.now() - tRoutes)})`,
    );
  }

  // --- country x day matrix ------------------------------------------------
  // The most expensive precomputation in the build: one filtered pass per
  // (country, day) cell. It is here rather than in the server because a
  // 512MB container should not spend a minute of every cold start on it.
  const matrix = [];
  if (config.matrixCountries > 0) {
    const matrixCountries = headline.byCountry.slice(0, config.matrixCountries);
    const cells = matrixCountries.length * DAYS;
    line(`country x day matrix (${matrixCountries.length} countries x ${DAYS} days = ${num(cells)} cells)`);
    const tMatrix = Date.now();
    let computed = 0;
    for (const country of matrixCountries) {
      const index = COUNTRIES.indexOf(country.code);
      const days = [];
      const row = [];
      for (let d = 0; d < DAYS; d++) {
        const from = EPOCH_START + d * DAY_MS;
        const slice = rollup(events, {
          fromMs: from,
          toMs: from + DAY_MS,
          country: index,
          label: `${country.code}@${d}`,
        });
        days.push(new Date(from).toISOString().slice(0, 10));
        row.push({
          requests: slice.totals.requests,
          errorRate: slice.totals.errorRate,
          p95Ms: slice.totals.p95Ms,
        });
        computed++;
        if (computed % 30 === 0) progress('cells', computed, cells);
      }
      matrix.push({ country: country.code, days, cells: row });
      line(`  ${country.code} row complete (${num(DAYS)} cells)`);
    }
    line(`  matrix complete (${formatMs(Date.now() - tMatrix)})`);
  }

  // --- the recomputable half + its checksum --------------------------------
  const recomputable = { windows, sessionStats, cohorts: cohortMatrix, funnel: funnelRows };
  const digest = checksum(recomputable);
  line(`checksum (recomputable half) ${digest}`);

  // --- determinism proof ---------------------------------------------------
  // Regenerate from the seed and recompute. If a change to the core made the
  // output depend on anything but the seed, the server would fail its own
  // warm-up check in production; catching it here is much cheaper.
  if (config.verifyDeterminism) {
    line('verifying reproducibility (regenerating the corpus from the seed)');
    const tVerify = Date.now();
    const replay = generateEvents(config.seed, config.events, (current, total) => {
      progress('replay', current, total);
    });
    const replayWindows = {};
    for (const days of config.windows) replayWindows[`${days}d`] = windowRollup(replay, days);
    const replayDigest = checksum({
      windows: replayWindows,
      sessionStats: sessionize(replay),
      cohorts: cohorts(replay),
      funnel: funnel(replay),
    });
    if (replayDigest !== digest) {
      throw new Error(
        `the corpus is not reproducible: ${digest} on the first pass, ${replayDigest} on the second`,
      );
    }
    line(`  reproducible — both passes agree (${formatMs(Date.now() - tVerify)})`);
  } else {
    warn('ANALYTICS_VERIFY=false — skipping the reproducibility check');
  }

  // --- emit ----------------------------------------------------------------
  const bundle = {
    seed: config.seed,
    events: config.events,
    users: events.userCount,
    sessions: sessionStats.sessions,
    generatedAt: new Date().toISOString(),
    checksum: digest,
    windows,
    sessionStats,
    cohorts: cohortMatrix,
    funnel: funnelRows,
    daily,
    hourly,
    weekly,
    drilldowns,
    routeDrilldowns,
    matrix,
  };

  await mkdir(GENERATED, { recursive: true });
  const json = JSON.stringify(bundle);
  await writeFile(`${GENERATED}/reports.json`, json, 'utf8');
  line(`wrote ${GENERATED}/reports.json (${formatBytes(Buffer.byteLength(json))})`);

  // A tiny TS module so the server gets the corpus parameters as compile-time
  // constants rather than re-reading them out of the JSON at runtime.
  const meta = `/**
 * GENERATED by scripts/stages/dataset.mjs — do not edit by hand.
 */
export const DATASET_SEED = ${config.seed};
export const DATASET_EVENTS = ${config.events};
export const DATASET_CHECKSUM = ${JSON.stringify(digest)};
export const DATASET_GENERATED_AT = ${JSON.stringify(bundle.generatedAt)};
`;
  await writeFile(`${GENERATED}/meta.ts`, meta, 'utf8');

  return {
    checksum: digest,
    bytes: Buffer.byteLength(json),
    events: config.events,
    users: events.userCount,
    sessions: sessionStats.sessions,
  };
}
