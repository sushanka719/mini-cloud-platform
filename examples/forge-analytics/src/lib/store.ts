/**
 * The in-memory analytics store.
 *
 * Built once at boot and then read-only. Two things live here:
 *
 *  - the **precomputed bundle** the build produced (daily/hourly/weekly slices,
 *    the country×day matrix, per-country and per-route drill-downs) — far too
 *    expensive to recompute on every container start;
 *  - the **event corpus itself**, regenerated from the seed, which is what lets
 *    `/api/query` answer arbitrary filter combinations the build never
 *    precomputed.
 *
 * That second half is the reason the warm-up costs real seconds, and the reason
 * the process holds real memory. It is a deliberate trade: an analytics service
 * that can only answer the questions its build anticipated is a worse demo than
 * one that can answer new ones.
 */
import {
  COUNTRIES,
  DAYS,
  DAY_MS,
  EPOCH_START,
  ROUTES,
  checksum,
  cohorts,
  funnel,
  generateEvents,
  rollup,
  sessionize,
  windowRollup,
  type EventTable,
} from './synth.mjs';
import { DATASET_CHECKSUM, DATASET_EVENTS, DATASET_SEED } from '../generated/meta';
import { registry } from '../generated/registry';
import bundleJson from '../generated/reports.json';
import type { AnyReport, Report, ReportBundle, Rollup } from './types';

const bundle = bundleJson as unknown as ReportBundle;

export type WarmupProgress = (message: string) => void;

export type QueryFilter = {
  country?: string | undefined;
  route?: string | undefined;
  hour?: number | undefined;
  fromDay?: number | undefined;
  toDay?: number | undefined;
};

export type StoreStats = {
  warmupMs: number;
  events: number;
  users: number;
  sessions: number;
  reports: number;
  checksum: string;
  checksumVerified: boolean;
  residentBytes: number;
};

export class AnalyticsStore {
  #events: EventTable;
  #windows: Record<string, Rollup>;
  #reports: Map<string, Report>;
  #stats: StoreStats;

  private constructor(
    events: EventTable,
    windows: Record<string, Rollup>,
    reports: Map<string, Report>,
    stats: StoreStats,
  ) {
    this.#events = events;
    this.#windows = windows;
    this.#reports = reports;
    this.#stats = stats;
  }

  /**
   * The warm-up.
   *
   * Every step announces itself, because these lines go to stdout, Docker
   * captures them, and ForgeCloud's worker follows the container's log into the
   * deployment log — so this is what the person watching the dashboard sees
   * while the health check is still polling.
   */
  static async warmUp(onProgress: WarmupProgress, strictChecksum: boolean): Promise<AnalyticsStore> {
    const startedAt = Date.now();

    onProgress(`regenerating ${DATASET_EVENTS.toLocaleString('en-US')} events from seed ${DATASET_SEED}`);
    const events = generateEvents(DATASET_SEED, DATASET_EVENTS, (current, total) => {
      if (current % 500_000 === 0) {
        onProgress(`  events ${current.toLocaleString('en-US')}/${total.toLocaleString('en-US')}`);
      }
    });

    onProgress('recomputing rolling windows');
    const windows: Record<string, Rollup> = {};
    for (const key of Object.keys(bundle.windows)) {
      const days = Number.parseInt(key, 10);
      if (!Number.isFinite(days)) continue;
      windows[key] = windowRollup(events, days);
    }

    onProgress('recomputing sessions, cohorts and funnel');
    const sessionStats = sessionize(events);
    const cohortMatrix = cohorts(events);
    const funnelRows = funnel(events);

    // The integrity check: this image's analytics core, run against this
    // image's seed, must reproduce the numbers this image was built with.
    const digest = checksum({
      windows,
      sessionStats,
      cohorts: cohortMatrix,
      funnel: funnelRows,
    });
    const verified = digest === DATASET_CHECKSUM;
    if (!verified) {
      const message =
        `warm-up checksum ${digest} does not match the build's ${DATASET_CHECKSUM} — ` +
        'the analytics core and the precomputed bundle disagree';
      if (strictChecksum) throw new Error(message);
      onProgress(`WARNING: ${message}`);
    } else {
      onProgress(`checksum verified against the build: ${digest.slice(0, 24)}…`);
    }

    onProgress(`computing ${registry.length} report definitions`);
    const reports = new Map<string, Report>();
    const headline = windows['90d'] ?? windowRollup(events, 90);
    for (const definition of registry) {
      reports.set(definition.id, definition.compute(headline));
    }

    const residentBytes = events.count * 26 + events.sessionCount * 12;
    const warmupMs = Date.now() - startedAt;
    onProgress(`warm-up complete in ${warmupMs}ms`);

    return new AnalyticsStore(events, windows, reports, {
      warmupMs,
      events: events.count,
      users: events.userCount,
      sessions: sessionStats.sessions,
      reports: reports.size,
      checksum: digest,
      checksumVerified: verified,
      residentBytes,
    });
  }

  get stats(): StoreStats {
    return this.#stats;
  }

  get bundle(): ReportBundle {
    return bundle;
  }

  get windowKeys(): string[] {
    return Object.keys(this.#windows);
  }

  window(key: string): Rollup | undefined {
    return this.#windows[key];
  }

  reportList(): Array<Pick<AnyReport, 'id' | 'title' | 'dimension' | 'metric' | 'unit'>> {
    return registry.map((definition) => ({
      id: definition.id,
      title: definition.title,
      dimension: definition.dimension,
      metric: definition.metric,
      unit: definition.unit,
    }));
  }

  /** A precomputed report, or one recomputed against a different window. */
  report(id: string, windowKey?: string): Report | undefined {
    if (windowKey === undefined) return this.#reports.get(id);
    const slice = this.#windows[windowKey];
    if (!slice) return undefined;
    const definition = registry.find((candidate) => candidate.id === id);
    return definition?.compute(slice);
  }

  /**
   * An arbitrary filtered rollup over the live corpus.
   *
   * This is what the resident event table buys: the build precomputed a fixed
   * set of slices, and this answers combinations it never anticipated —
   * "Germany, /api/v1/logs, 14:00, days 30-60" — by walking the corpus.
   */
  query(filter: QueryFilter): Rollup | { error: string } {
    const options: Parameters<typeof rollup>[1] = {};
    const parts: string[] = [];

    if (filter.country !== undefined && filter.country !== '') {
      const index = COUNTRIES.indexOf(filter.country);
      if (index < 0) return { error: `unknown country ${JSON.stringify(filter.country)}` };
      options.country = index;
      parts.push(`country=${filter.country}`);
    }
    if (filter.route !== undefined && filter.route !== '') {
      const index = ROUTES.indexOf(filter.route);
      if (index < 0) return { error: `unknown route ${JSON.stringify(filter.route)}` };
      options.route = index;
      parts.push(`route=${filter.route}`);
    }
    if (filter.hour !== undefined) {
      if (!Number.isInteger(filter.hour) || filter.hour < 0 || filter.hour > 23) {
        return { error: 'hour must be an integer between 0 and 23' };
      }
      options.hour = filter.hour;
      parts.push(`hour=${filter.hour}`);
    }
    if (filter.fromDay !== undefined || filter.toDay !== undefined) {
      const from = filter.fromDay ?? 0;
      const to = filter.toDay ?? DAYS;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > DAYS || from >= to) {
        return { error: `fromDay/toDay must satisfy 0 <= fromDay < toDay <= ${DAYS}` };
      }
      options.fromMs = EPOCH_START + from * DAY_MS;
      options.toMs = EPOCH_START + to * DAY_MS;
      parts.push(`days=${from}..${to}`);
    }
    options.label = parts.length > 0 ? parts.join(' ') : 'all';
    return rollup(this.#events, options);
  }
}
