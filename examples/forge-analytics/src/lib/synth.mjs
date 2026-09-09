/**
 * The analytics core: deterministic event synthesis, rollups, sessionization,
 * cohort retention and funnel analysis.
 *
 * Plain ESM JavaScript on purpose — it has two consumers that cannot share a
 * compiled artifact:
 *
 *  - `scripts/stages/*.mjs`, which run on the *build* host under plain `node`,
 *    before any TypeScript has been emitted;
 *  - `src/server.ts`, which is type-checked and bundled into `dist/`.
 *
 * Both must produce byte-identical numbers, because the server verifies its
 * warm-up against the checksum the build recorded and refuses to serve if they
 * disagree. One implementation is the only way to guarantee that, so the types
 * live beside it in `synth.d.mts` rather than the code being duplicated.
 *
 * Everything is seeded: no `Math.random`, no `Date.now`, no accumulation whose
 * order depends on object iteration. Same seed and scale in, same checksum out,
 * on any machine.
 */
import { createHash } from 'node:crypto';

/** Dimensions. Order is part of the wire format — appending is safe, reordering is not. */
export const ROUTES = [
  '/', '/pricing', '/docs', '/docs/quickstart', '/docs/api', '/blog',
  '/blog/scaling-node', '/login', '/signup', '/app', '/app/projects',
  '/app/deployments', '/app/logs', '/app/settings', '/api/v1/projects',
  '/api/v1/deployments', '/api/v1/logs', '/api/v1/metrics', '/api/v1/auth',
  '/api/v1/webhooks', '/status', '/changelog', '/support', '/legal/privacy',
];

export const COUNTRIES = [
  'NP', 'IN', 'US', 'GB', 'DE', 'FR', 'NL', 'SE', 'NO', 'FI', 'PL', 'ES',
  'IT', 'PT', 'IE', 'CA', 'BR', 'MX', 'AR', 'AU', 'NZ', 'JP', 'KR', 'CN',
  'SG', 'MY', 'ID', 'PH', 'TH', 'VN', 'AE', 'ZA',
];

export const DEVICES = ['desktop', 'mobile', 'tablet', 'bot'];

export const STATUSES = [200, 201, 204, 301, 304, 400, 401, 403, 404, 429, 500, 502, 503];

/** Index in STATUSES at which a code counts as an error. */
const FIRST_ERROR_STATUS = STATUSES.findIndex((code) => code >= 400);

/** The funnel the dashboard reports on, as indices into ROUTES. */
export const FUNNEL = ['/', '/pricing', '/signup', '/app'];

/** Wall-clock span the synthetic events cover. Fixed, so the output is stable. */
export const EPOCH_START = Date.UTC(2026, 5, 10, 0, 0, 0);
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export const DAYS = 90;
export const COHORT_WEEKS = 13;

/** Inactivity gap that ends a session. */
export const SESSION_GAP_MS = 1_800_000;

/**
 * How wide a session's events are spread around its anchor. Must stay under
 * SESSION_GAP_MS or a session would split itself in two.
 */
export const SESSION_WINDOW_MS = 1_500_000;

/** Latency histogram: 1024 buckets of 4ms, so percentiles are exact to 4ms. */
const HIST_BUCKETS = 1024;
const HIST_STEP_MS = 4;

/**
 * mulberry32 — a small, fast, well-distributed 32-bit PRNG.
 *
 * Chosen over `Math.random` because the dataset has to be reproducible from a
 * seed: the build computes aggregates from it and the server recomputes them at
 * boot, and the two are compared.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks an index from a cumulative weight table by binary search. */
function pickCumulative(r, cumulative) {
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (r > cumulative[mid]) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Zipf-ish cumulative weights: a few routes take most of the traffic, like real sites. */
function zipfCumulative(n, exponent) {
  const cumulative = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += 1 / Math.pow(i + 1, exponent);
    cumulative[i] = total;
  }
  for (let i = 0; i < n; i++) cumulative[i] /= total;
  return cumulative;
}

/**
 * The shape of the dataset for a given event count.
 *
 * Sessions and users are derived from `count` rather than configured
 * separately, so one knob changes the scale without changing the character of
 * the data — ~4.2 events per session and ~3.5 sessions per user hold at every
 * size, which is what keeps the bounce rate and retention curve comparable
 * across scales.
 */
export function shapeFor(count) {
  const sessions = Math.max(500, Math.floor(count / 4.2));
  const users = Math.max(200, Math.floor(sessions / 3.5));
  return { sessions, users };
}

/**
 * Generates `count` events into flat typed arrays (a struct-of-arrays layout).
 *
 * Typed arrays rather than objects: 1.5M `{route, country, …}` objects cost
 * several hundred MB and a lot of GC, and the container this runs in has a
 * 512MB cap. This layout is ~26 bytes per event.
 *
 * Events are generated *through sessions* rather than independently. Scattering
 * timestamps uniformly across 90 days would put every event of a user hours
 * apart, so every session would be a bounce and the retention curve would be
 * noise. Instead each session gets an anchor time and a user, and its events
 * land within a 25-minute window of that anchor — which is what produces a
 * believable bounce rate, session length and cohort curve.
 */
export function generateEvents(seed, count, onProgress, progressEvery = 250_000) {
  const random = mulberry32(seed);
  const { sessions: sessionCount, users: userCount } = shapeFor(count);
  const routeCumulative = zipfCumulative(ROUTES.length, 1.1);
  const countryCumulative = zipfCumulative(COUNTRIES.length, 0.9);

  // --- session skeleton ----------------------------------------------------
  // Built first so every event can be attached to a session that already knows
  // when it happened and who it belonged to.
  const sessionAnchor = new Float64Array(sessionCount);
  const sessionUser = new Uint32Array(sessionCount);
  for (let s = 0; s < sessionCount; s++) {
    // A user's sessions cluster around their signup day and drift later, which
    // is what gives the cohort matrix a decaying shape instead of a flat one.
    const user = 1 + Math.floor(random() * userCount);
    const signupDay = ((user * 2654435761) >>> 0) % (DAYS - 7);
    const returnDay = Math.min(DAYS - 1, signupDay + Math.floor(Math.pow(random(), 2.2) * (DAYS - signupDay)));
    const weekday = (returnDay + 3) % 7;
    // Time of day. The mean of three uniforms is approximately normal, which
    // gives the hour-of-day profile a real hump instead of the flat plateau a
    // single uniform (or a power curve over a truncated range) produces.
    // Weekends peak later and spread wider, which is what weekend traffic does.
    const u = (random() + random() + random()) / 3;
    const centre = weekday >= 5 ? 0.58 : 0.53;
    const spread = weekday >= 5 ? 1.25 : 1.0;
    const hour = Math.max(0, Math.min(23, Math.floor(24 * (centre + (u - 0.5) * spread))));
    sessionUser[s] = user;
    // Clamped so that anchor + the widest in-session offset still lands inside
    // the corpus. Without this a handful of events fall past day 89, and
    // because the per-day accumulators are typed arrays their out-of-range
    // writes are silently discarded — the totals would then disagree with the
    // sum of the daily rows by a few dozen events, which is exactly the kind of
    // drift the checksum exists to catch.
    sessionAnchor[s] = Math.min(
      EPOCH_START + DAYS * DAY_MS - SESSION_WINDOW_MS - 1,
      EPOCH_START + returnDay * DAY_MS + hour * 3_600_000 + Math.floor(random() * 3_600_000),
    );
  }

  const timestamp = new Float64Array(count);
  const route = new Uint8Array(count);
  const country = new Uint8Array(count);
  const device = new Uint8Array(count);
  const status = new Uint8Array(count);
  const durationMs = new Uint16Array(count);
  const bytes = new Uint32Array(count);
  const userId = new Uint32Array(count);
  const session = new Uint32Array(count);

  for (let i = 0; i < count; i++) {
    const s = Math.floor(random() * sessionCount);
    session[i] = s;
    userId[i] = sessionUser[s];
    // Within the session window. Sorted later; the gap to the next event stays
    // under SESSION_GAP_MS by construction, so the session survives grouping.
    timestamp[i] = sessionAnchor[s] + Math.floor(random() * SESSION_WINDOW_MS);

    const r = pickCumulative(random(), routeCumulative);
    route[i] = r;
    country[i] = pickCumulative(random(), countryCumulative);

    const d = random();
    device[i] = d < 0.52 ? 0 : d < 0.88 ? 1 : d < 0.97 ? 2 : 3;

    // API routes are faster and fail differently from page routes.
    const isApi = ROUTES[r].charCodeAt(1) === 97 && ROUTES[r].startsWith('/api/');
    const base = isApi ? 14 : 90;
    const spread = isApi ? 70 : 380;
    // A log-normal-ish tail: most requests are quick, a few are genuinely slow,
    // which is what makes p50/p95/p99 tell three different stories.
    const u = random();
    const tail = Math.pow(1 - u, -0.42) - 1;
    durationMs[i] = Math.min(65_535, Math.round(base + spread * Math.min(tail, 24)));

    // Error budget: ~1.6% server errors on API, ~0.7% on pages, plus the
    // everyday 404/401/429 noise. Lands around 4% overall.
    const roll = random();
    const serverErr = isApi ? 0.016 : 0.007;
    if (roll < serverErr * 0.30) status[i] = 12;
    else if (roll < serverErr * 0.65) status[i] = 11;
    else if (roll < serverErr) status[i] = 10;
    else if (roll < serverErr + 0.0150) status[i] = 8;
    else if (roll < serverErr + 0.0205) status[i] = 6;
    else if (roll < serverErr + 0.0235) status[i] = 9;
    else if (roll < serverErr + 0.0250) status[i] = 7;
    else if (roll < serverErr + 0.0265) status[i] = 5;
    else if (roll < serverErr + 0.1100) status[i] = 4;
    else if (roll < serverErr + 0.1250) status[i] = 3;
    else status[i] = isApi ? (random() < 0.22 ? 1 : random() < 0.08 ? 2 : 0) : 0;

    bytes[i] = Math.round((isApi ? 900 : 24_000) * (0.35 + random() * 1.9));

    if (onProgress && (i + 1) % progressEvery === 0) onProgress(i + 1, count);
  }

  return {
    count,
    seed,
    userCount,
    sessionCount,
    timestamp,
    route,
    country,
    device,
    status,
    durationMs,
    bytes,
    userId,
    session,
  };
}

/** Percentile out of a latency histogram. Exact to the bucket width (4ms). */
function percentileFrom(hist, total, p) {
  if (total === 0) return 0;
  const target = Math.ceil((p / 100) * total);
  let seen = 0;
  for (let b = 0; b < hist.length; b++) {
    seen += hist[b];
    if (seen >= target) return b * HIST_STEP_MS;
  }
  return (hist.length - 1) * HIST_STEP_MS;
}

/**
 * One pass over the events producing every rollup the dashboard shows.
 *
 * One pass rather than one per chart: the arrays are large enough that memory
 * bandwidth dominates, and re-walking them five times costs measurably more
 * than the extra accumulators do.
 *
 * `window` limits the rollup to the last N days, which is how the build
 * produces its 7 / 30 / 90-day reports from a single dataset.
 */
export function rollup(events, options = {}) {
  const { count } = events;
  const fromMs = options.fromMs ?? EPOCH_START;
  const toMs = options.toMs ?? EPOCH_START + DAYS * DAY_MS;
  const onlyCountry = options.country ?? -1;
  const onlyRoute = options.route ?? -1;
  const onlyHour = options.hour ?? -1;
  const label = options.label ?? 'all';

  const dayCount = new Uint32Array(DAYS);
  const dayErrors = new Uint32Array(DAYS);
  const dayBytes = new Float64Array(DAYS);
  const dayDuration = new Float64Array(DAYS);

  const routeCount = new Uint32Array(ROUTES.length);
  const routeErrors = new Uint32Array(ROUTES.length);
  const routeBytes = new Float64Array(ROUTES.length);
  const routeHist = [];
  for (let i = 0; i < ROUTES.length; i++) routeHist.push(new Uint32Array(HIST_BUCKETS));

  const countryCount = new Uint32Array(COUNTRIES.length);
  const countryBytes = new Float64Array(COUNTRIES.length);
  const deviceCount = new Uint32Array(DEVICES.length);
  const statusCount = new Uint32Array(STATUSES.length);
  const globalHist = new Uint32Array(HIST_BUCKETS);

  let totalBytes = 0;
  let totalDuration = 0;
  let errors = 0;
  let included = 0;

  for (let i = 0; i < count; i++) {
    const ts = events.timestamp[i];
    if (ts < fromMs || ts >= toMs) continue;
    const r = events.route[i];
    if (onlyRoute >= 0 && r !== onlyRoute) continue;
    if (onlyCountry >= 0 && events.country[i] !== onlyCountry) continue;
    // Hour-of-day, not hour-of-corpus: this is the "when is our traffic busy"
    // question, so every 14:00 in the 90 days folds into one bucket.
    if (onlyHour >= 0 && Math.floor((ts % DAY_MS) / 3_600_000) !== onlyHour) continue;
    const day = Math.floor((ts - EPOCH_START) / DAY_MS);
    const s = events.status[i];
    const dur = events.durationMs[i];
    const by = events.bytes[i];
    const isError = s >= FIRST_ERROR_STATUS;
    const bucket = Math.min(HIST_BUCKETS - 1, (dur / HIST_STEP_MS) | 0);

    dayCount[day]++;
    dayBytes[day] += by;
    dayDuration[day] += dur;
    if (isError) dayErrors[day]++;

    routeCount[r]++;
    routeBytes[r] += by;
    routeHist[r][bucket]++;
    if (isError) routeErrors[r]++;

    countryCount[events.country[i]]++;
    countryBytes[events.country[i]] += by;
    deviceCount[events.device[i]]++;
    statusCount[s]++;
    globalHist[bucket]++;

    totalBytes += by;
    totalDuration += dur;
    included++;
    if (isError) errors++;
  }

  const firstDay = Math.max(0, Math.floor((fromMs - EPOCH_START) / DAY_MS));
  const lastDay = Math.min(DAYS, Math.ceil((toMs - EPOCH_START) / DAY_MS));
  const byDay = [];
  for (let d = firstDay; d < lastDay; d++) {
    byDay.push({
      date: new Date(EPOCH_START + d * DAY_MS).toISOString().slice(0, 10),
      requests: dayCount[d],
      errors: dayErrors[d],
      bytes: Math.round(dayBytes[d]),
      avgDurationMs: dayCount[d] === 0 ? 0 : round2(dayDuration[d] / dayCount[d]),
    });
  }

  const byRoute = ROUTES.map((path, r) => ({
    path,
    requests: routeCount[r],
    errors: routeErrors[r],
    errorRate: routeCount[r] === 0 ? 0 : round4(routeErrors[r] / routeCount[r]),
    bytes: Math.round(routeBytes[r]),
    p50Ms: percentileFrom(routeHist[r], routeCount[r], 50),
    p95Ms: percentileFrom(routeHist[r], routeCount[r], 95),
    p99Ms: percentileFrom(routeHist[r], routeCount[r], 99),
  })).sort((a, b) => b.requests - a.requests || (a.path < b.path ? -1 : 1));

  const byCountry = COUNTRIES.map((code, c) => ({
    code,
    requests: countryCount[c],
    bytes: Math.round(countryBytes[c]),
  })).sort((a, b) => b.requests - a.requests || (a.code < b.code ? -1 : 1));

  const byDevice = DEVICES.map((name, d) => ({ name, requests: deviceCount[d] })).sort(
    (a, b) => b.requests - a.requests || (a.name < b.name ? -1 : 1),
  );

  const byStatus = STATUSES.map((code, s) => ({ code, requests: statusCount[s] }))
    .filter((row) => row.requests > 0)
    .sort((a, b) => b.requests - a.requests || a.code - b.code);

  return {
    window: { label, fromMs, toMs, days: lastDay - firstDay },
    totals: {
      requests: included,
      errors,
      errorRate: included === 0 ? 0 : round4(errors / included),
      bytes: Math.round(totalBytes),
      avgDurationMs: included === 0 ? 0 : round2(totalDuration / included),
      p50Ms: percentileFrom(globalHist, included, 50),
      p95Ms: percentileFrom(globalHist, included, 95),
      p99Ms: percentileFrom(globalHist, included, 99),
    },
    byDay,
    byRoute,
    byCountry,
    byDevice,
    byStatus,
  };
}

/**
 * A trailing-window rollup: the last `days` days of the corpus.
 *
 * The dashboard's 7/30/90-day tabs and the build's headline numbers all come
 * through here, so "last 30 days" means exactly one thing everywhere.
 */
export function windowRollup(events, days) {
  return rollup(events, {
    fromMs: EPOCH_START + (DAYS - days) * DAY_MS,
    label: `${days}d`,
  });
}

/**
 * Groups events into user sessions on a 30-minute inactivity gap.
 *
 * The expensive stage, deliberately: it sorts every event by (user, timestamp),
 * which is the O(n log n) pass that makes this feel like a real build. An index
 * sort rather than sorting the arrays themselves — permuting nine parallel
 * arrays would cost far more than ordering one index does.
 */
export function sessionize(events, gapMs = SESSION_GAP_MS, onProgress) {
  const { count } = events;
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  if (onProgress) onProgress(0, count, 'sorting');

  // TypedArray#sort with a comparator — not Array.prototype.sort.call, which
  // goes through the generic (much slower) path for typed arrays.
  order.sort((a, b) => {
    const ua = events.userId[a];
    const ub = events.userId[b];
    if (ua !== ub) return ua - ub;
    return events.timestamp[a] - events.timestamp[b];
  });

  let sessions = 0;
  let bounced = 0;
  let totalEvents = 0;
  let totalSessionMs = 0;
  let longest = 0;
  let currentUser = -1;
  let lastTs = 0;
  let sessionEvents = 0;
  let sessionStart = 0;

  const closeSession = () => {
    if (sessionEvents === 0) return;
    sessions++;
    totalEvents += sessionEvents;
    const span = lastTs - sessionStart;
    totalSessionMs += span;
    if (span > longest) longest = span;
    if (sessionEvents === 1) bounced++;
  };

  for (let k = 0; k < count; k++) {
    const i = order[k];
    const user = events.userId[i];
    const ts = events.timestamp[i];
    if (user !== currentUser || ts - lastTs > gapMs) {
      closeSession();
      currentUser = user;
      sessionStart = ts;
      sessionEvents = 0;
    }
    sessionEvents++;
    lastTs = ts;
    if (onProgress && (k + 1) % 500_000 === 0) onProgress(k + 1, count, 'grouping');
  }
  closeSession();

  return {
    sessions,
    bouncedSessions: bounced,
    bounceRate: sessions === 0 ? 0 : round4(bounced / sessions),
    avgEventsPerSession: sessions === 0 ? 0 : round2(totalEvents / sessions),
    avgSessionSeconds: sessions === 0 ? 0 : round2(totalSessionMs / sessions / 1000),
    longestSessionSeconds: round2(longest / 1000),
  };
}

/**
 * Weekly cohort retention: of the users first seen in week N, what fraction
 * came back in week N+k.
 *
 * Two passes plus a bitmap. The bitmap (`users × weeks`, one byte each) is what
 * keeps this linear — the obvious `Map<user, Set<week>>` allocates millions of
 * objects and is an order of magnitude slower.
 */
export function cohorts(events, onProgress) {
  const { count, userCount } = events;
  const firstWeek = new Uint8Array(userCount + 1).fill(255);
  const seen = new Uint8Array((userCount + 1) * COHORT_WEEKS);

  for (let i = 0; i < count; i++) {
    const week = Math.min(COHORT_WEEKS - 1, Math.floor((events.timestamp[i] - EPOCH_START) / WEEK_MS));
    const u = events.userId[i];
    if (week < firstWeek[u]) firstWeek[u] = week;
    seen[u * COHORT_WEEKS + week] = 1;
    if (onProgress && (i + 1) % 500_000 === 0) onProgress(i + 1, count, 'marking');
  }

  const size = new Uint32Array(COHORT_WEEKS);
  const returned = [];
  for (let w = 0; w < COHORT_WEEKS; w++) returned.push(new Uint32Array(COHORT_WEEKS));

  for (let u = 1; u <= userCount; u++) {
    const first = firstWeek[u];
    if (first === 255) continue;
    size[first]++;
    const row = u * COHORT_WEEKS;
    for (let w = first; w < COHORT_WEEKS; w++) {
      if (seen[row + w] === 1) returned[first][w - first]++;
    }
  }

  const matrix = [];
  for (let w = 0; w < COHORT_WEEKS; w++) {
    const offsets = [];
    for (let k = 0; k + w < COHORT_WEEKS; k++) {
      offsets.push(size[w] === 0 ? 0 : round4(returned[w][k] / size[w]));
    }
    matrix.push({
      cohort: new Date(EPOCH_START + w * WEEK_MS).toISOString().slice(0, 10),
      users: size[w],
      retention: offsets,
    });
  }
  return matrix;
}

/**
 * Funnel conversion: how many users reached each stage, in order, by first
 * touch. A user counts at stage k only if they also reached every stage before
 * it, and no earlier than they reached it.
 */
export function funnel(events, onProgress) {
  const { count, userCount } = events;
  const stages = FUNNEL.map((path) => ROUTES.indexOf(path)).filter((i) => i >= 0);
  const first = new Float64Array((userCount + 1) * stages.length).fill(Infinity);

  for (let i = 0; i < count; i++) {
    const stage = stages.indexOf(events.route[i]);
    if (stage >= 0) {
      const slot = events.userId[i] * stages.length + stage;
      const ts = events.timestamp[i];
      if (ts < first[slot]) first[slot] = ts;
    }
    if (onProgress && (i + 1) % 500_000 === 0) onProgress(i + 1, count, 'scanning');
  }

  const reached = new Uint32Array(stages.length);
  for (let u = 1; u <= userCount; u++) {
    const row = u * stages.length;
    let previous = -Infinity;
    for (let s = 0; s < stages.length; s++) {
      const ts = first[row + s];
      if (ts === Infinity || ts < previous) break;
      reached[s]++;
      previous = ts;
    }
  }

  return FUNNEL.slice(0, stages.length).map((path, s) => ({
    stage: s + 1,
    path,
    users: reached[s],
    conversionFromStart: reached[0] === 0 ? 0 : round4(reached[s] / reached[0]),
    conversionFromPrevious:
      s === 0 || reached[s - 1] === 0 ? 1 : round4(reached[s] / reached[s - 1]),
  }));
}

/**
 * The agreement between build and runtime.
 *
 * Hashes the *aggregates*, not the raw events: it is the derived numbers the
 * dashboard shows, so a drift in the rollup logic is what we want to catch.
 * Keys are sorted so the digest never depends on insertion order.
 */
export function checksum(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
function round4(n) {
  return Math.round(n * 10_000) / 10_000;
}
