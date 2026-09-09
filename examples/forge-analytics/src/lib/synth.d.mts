/**
 * Types for `synth.mjs`.
 *
 * The implementation is plain JavaScript because the build scripts run it under
 * bare `node` before any TypeScript exists (see the header of `synth.mjs`).
 * Declaring it here rather than setting `allowJs` keeps the rest of the project
 * under full `strict` checking, and makes the contract between the build and
 * the server explicit in one readable file.
 */
import type { CohortRow, FunnelRow, Rollup, SessionStats } from './types.js';

export declare const ROUTES: readonly string[];
export declare const COUNTRIES: readonly string[];
export declare const DEVICES: readonly string[];
export declare const STATUSES: readonly number[];
export declare const FUNNEL: readonly string[];
export declare const EPOCH_START: number;
export declare const DAY_MS: number;
export declare const WEEK_MS: number;
export declare const DAYS: number;
export declare const COHORT_WEEKS: number;
export declare const SESSION_GAP_MS: number;

/** Struct-of-arrays event table. Nine parallel arrays, one entry per event. */
export type EventTable = {
  readonly count: number;
  readonly seed: number;
  readonly userCount: number;
  readonly sessionCount: number;
  readonly timestamp: Float64Array;
  readonly route: Uint8Array;
  readonly country: Uint8Array;
  readonly device: Uint8Array;
  readonly status: Uint8Array;
  readonly durationMs: Uint16Array;
  readonly bytes: Uint32Array;
  readonly userId: Uint32Array;
  readonly session: Uint32Array;
};

export type ProgressFn = (current: number, total: number, phase?: string) => void;

export declare function mulberry32(seed: number): () => number;
export declare function shapeFor(count: number): { sessions: number; users: number };
export declare function generateEvents(
  seed: number,
  count: number,
  onProgress?: ProgressFn | null,
  progressEvery?: number,
): EventTable;
export type RollupFilter = {
  fromMs?: number;
  toMs?: number;
  /** Index into COUNTRIES, or -1 for all. */
  country?: number;
  /** Index into ROUTES, or -1 for all. */
  route?: number;
  /** Hour of day 0-23, or -1 for all. */
  hour?: number;
  label?: string;
};

export declare function rollup(events: EventTable, options?: RollupFilter): Rollup;
export declare function windowRollup(events: EventTable, days: number): Rollup;
export declare function sessionize(
  events: EventTable,
  gapMs?: number,
  onProgress?: ProgressFn | null,
): SessionStats;
export declare function cohorts(events: EventTable, onProgress?: ProgressFn | null): CohortRow[];
export declare function funnel(events: EventTable, onProgress?: ProgressFn | null): FunnelRow[];
export declare function checksum(value: unknown): string;
export declare function stableStringify(value: unknown): string;
