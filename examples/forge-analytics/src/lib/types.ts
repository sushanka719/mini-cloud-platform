/**
 * The type surface shared by the analytics core, the generated report modules
 * and the server.
 *
 * This is what makes the `typecheck` build stage worth its seconds: the
 * generated modules are checked against these types, so a codegen template that
 * asks for a metric a dimension does not have fails the build rather than
 * producing a dashboard full of `undefined`.
 */

export type Dimension = 'day' | 'route' | 'country' | 'device' | 'status';

export type Metric =
  | 'requests'
  | 'errors'
  | 'errorRate'
  | 'bytes'
  | 'avgDurationMs'
  | 'p50Ms'
  | 'p95Ms'
  | 'p99Ms';

export type DayRow = {
  date: string;
  requests: number;
  errors: number;
  bytes: number;
  avgDurationMs: number;
};

export type RouteRow = {
  path: string;
  requests: number;
  errors: number;
  errorRate: number;
  bytes: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
};

export type CountryRow = { code: string; requests: number; bytes: number };
export type DeviceRow = { name: string; requests: number };
export type StatusRow = { code: number; requests: number };

export type Totals = {
  requests: number;
  errors: number;
  errorRate: number;
  bytes: number;
  avgDurationMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
};

export type RollupWindow = {
  /** Human label: "90d", "2026-07-01", "country:NP". */
  label: string;
  fromMs: number;
  toMs: number;
  days: number;
};

export type Rollup = {
  window: RollupWindow;
  totals: Totals;
  byDay: DayRow[];
  byRoute: RouteRow[];
  byCountry: CountryRow[];
  byDevice: DeviceRow[];
  byStatus: StatusRow[];
};

export type SessionStats = {
  sessions: number;
  bouncedSessions: number;
  bounceRate: number;
  avgEventsPerSession: number;
  avgSessionSeconds: number;
  longestSessionSeconds: number;
};

export type CohortRow = { cohort: string; users: number; retention: number[] };

export type FunnelRow = {
  stage: number;
  path: string;
  users: number;
  conversionFromStart: number;
  conversionFromPrevious: number;
};

/** Maps a dimension to the row type it produces. */
export type RowFor<D extends Dimension> = D extends 'day'
  ? DayRow
  : D extends 'route'
    ? RouteRow
    : D extends 'country'
      ? CountryRow
      : D extends 'device'
        ? DeviceRow
        : StatusRow;

/**
 * The metrics a dimension actually carries.
 *
 * The whole point of the generated-module typecheck: asking for `p95Ms` on the
 * `country` dimension is a compile error, not a runtime `NaN`.
 */
export type MetricFor<D extends Dimension> = Extract<
  { [K in keyof RowFor<D>]: RowFor<D>[K] extends number ? K : never }[keyof RowFor<D>],
  Metric
>;

/** Whatever a row's label column is called, per dimension. */
export type LabelFor<D extends Dimension> = D extends 'day'
  ? 'date'
  : D extends 'route'
    ? 'path'
    : D extends 'country'
      ? 'code'
      : D extends 'device'
        ? 'name'
        : 'code';

export type ReportRow = {
  key: string;
  value: number;
  /** Fraction of the report's total, 0..1. */
  share: number;
};

export type Report = {
  id: string;
  title: string;
  dimension: Dimension;
  metric: Metric;
  unit: ReportUnit;
  rows: ReportRow[];
  total: number;
};

export type ReportUnit = 'count' | 'bytes' | 'ms' | 'ratio';

/**
 * One generated report. `compute` is written by codegen and checked here, so
 * every module in `src/generated/reports/` has the same shape by construction.
 */
export type ReportDefinition<D extends Dimension = Dimension> = {
  readonly id: string;
  readonly title: string;
  readonly dimension: D;
  readonly metric: MetricFor<D>;
  readonly unit: ReportUnit;
  readonly limit: number;
  readonly compute: (rollup: Rollup) => Report;
};

/** A filtered slice the build precomputes but the server does not recompute. */
export type Drilldown = {
  key: string;
  label: string;
  totals: Totals;
  topRoutes: Array<{ path: string; requests: number; errorRate: number }>;
};

/**
 * What the build writes to `src/generated/reports.json` and the server loads.
 *
 * Split deliberately into two halves. `windows`, `sessionStats`, `cohorts` and
 * `funnel` are *recomputable*: the server regenerates the same corpus at boot
 * and checks its own numbers against `checksum` before serving. `daily` and
 * `drilldowns` are build-only — 90 daily rollups and a rollup per country are
 * worth precomputing once on a build host and not worth repeating in a
 * 512MB container on every start.
 */
export type MatrixCell = { requests: number; errorRate: number; p95Ms: number };

/** One country's requests per day — the build's most expensive precomputation. */
export type CountryDayMatrix = { country: string; days: string[]; cells: MatrixCell[] };

export type ReportBundle = {
  seed: number;
  events: number;
  users: number;
  sessions: number;
  generatedAt: string;
  /** sha256 over the recomputable half. The server verifies its warm-up against it. */
  checksum: string;
  windows: Record<string, Rollup>;
  sessionStats: SessionStats;
  cohorts: CohortRow[];
  funnel: FunnelRow[];
  daily: Drilldown[];
  hourly: Drilldown[];
  weekly: Drilldown[];
  drilldowns: Drilldown[];
  routeDrilldowns: Drilldown[];
  matrix: CountryDayMatrix[];
};

/** What the build stamps into `dist/build-info.json`. */
export type BuildInfo = {
  app: string;
  version: string;
  builtAt: string;
  node: string;
  platform: string;
  durationMs: number;
  stages: Array<{ title: string; ms: number }>;
  config: {
    seed: number;
    events: number;
    modules: number;
    scale: number;
  };
  forge: {
    deploymentId: string | null;
    projectId: string | null;
    orgId: string | null;
    workerId: string | null;
    attempt: string | null;
  };
  checksum: string;
  assets: Array<{ file: string; bytes: number; sha256: string }>;
};

/**
 * A report definition with its dimension erased.
 *
 * The registry holds every generated module together, and `ReportDefinition<D>`
 * is generic, so it needs a common supertype. Written out rather than
 * `ReportDefinition<Dimension>` because the conditional types behind
 * `MetricFor` distribute over a union in ways that are easy to get subtly wrong
 * — this states the erased shape directly, and each module still gets the
 * strict per-dimension check on the way in.
 */
export type AnyReport = {
  readonly id: string;
  readonly title: string;
  readonly dimension: Dimension;
  readonly metric: Metric;
  readonly unit: ReportUnit;
  readonly limit: number;
  readonly compute: (rollup: Rollup) => Report;
};
