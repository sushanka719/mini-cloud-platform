/**
 * Binary search over an already-sorted array.
 *
 * This is the one *classical* algorithm in the codebase that is written out
 * rather than delegated. Everywhere else the sorted-lookup work is done by
 * something else's implementation — Postgres' B-tree indexes answer
 * `WHERE created_at <= $1 ORDER BY ... LIMIT 1`, and `Array.prototype.sort`
 * answers `percentileOf`. Those are the right answers *server-side*, where the
 * data lives on disk behind an index.
 *
 * They are the wrong answer for the two callers here, both in the browser:
 *
 *  - The deployment history is already in memory, sorted `created_at DESC`,
 *    fetched once. Asking the API "which deployment was current at 14:32?" is a
 *    network round trip per keystroke of a time input to answer a question the
 *    page can already answer locally.
 *  - The log timeline de-duplicates every incoming batch of events against
 *    what is already on screen. That list is sorted on a monotonic event id,
 *    it runs on the log-streaming hot path, and the alternative it replaced
 *    rebuilt a `Set` of the whole timeline to answer a handful of questions.
 *
 * So: O(log n) instead of O(n), on data that is local and provably ordered.
 *
 * `searchRange`/`sliceRange` have no caller yet — the metric series in
 * `lib/metrics.ts` are the obvious one, but nothing filters a chart by time
 * window today. They are here because they are the same loop and the same
 * tests, not because something is waiting on them.
 *
 * ## The invariant
 *
 * Every function below is the same loop over a half-open range `[lo, hi)`.
 * `lo` is the answer's lower bound, `hi` its exclusive upper bound, and the
 * loop shrinks the gap until they meet. Because the range is half-open, `hi`
 * starts at `length` (not `length - 1`), an empty array terminates
 * immediately, and a target past the end returns `length` — which is exactly
 * the index it would be inserted at. There is no "not found" special case to
 * forget.
 *
 * The midpoint is `lo + ((hi - lo) >> 1)`, not `(lo + hi) >> 1`. The two agree
 * for every array JavaScript can hold, and the first is the form that does not
 * overflow when the sum exceeds the integer width — the bug that sat in
 * Java's `binarySearch` for nine years. Written the safe way because the
 * habit is the point, not because a 150-element chart series is at risk.
 */

/** Negative if `a` sorts before `b`, positive if after, 0 if equivalent. */
export type Comparator<K> = (a: K, b: K) => number;

/** Which way the array being searched is ordered. */
export type SortOrder = 'asc' | 'desc';

export type SearchOptions<K> = {
  /** Defaults to `<`/`>`, which is correct for numbers, strings and Dates. */
  compare?: Comparator<K>;
  /** Defaults to `'asc'`. Pass `'desc'` for a newest-first list. */
  order?: SortOrder;
  /**
   * Called with every index the search probes, in order.
   *
   * Present so the dashboard can *show* the probe sequence — the point of
   * implementing this by hand is lost if the O(log n) is invisible. Costs
   * nothing when it isn't passed.
   */
  onProbe?: (index: number) => void;
};

function defaultCompare<K>(a: K, b: K): number {
  if (Object.is(a, b)) return 0;
  // The relational operators are defined for every key type we search on
  // (number, string, Date). TypeScript cannot prove that for a free `K`, so
  // the comparison is done through a widened view rather than by weakening
  // `K` at every call site.
  const [x, y] = [a, b] as unknown as [number, number];
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The comparator the loop actually uses.
 *
 * A descending array is an ascending one under a negated comparator, so
 * `order: 'desc'` is handled by flipping the sign here rather than by keeping
 * a second copy of every loop below. Every function in this file therefore
 * reads in *array order*: "before" means "nearer index 0", whichever direction
 * the keys themselves run.
 */
function effectiveComparator<K>(options: SearchOptions<K>): Comparator<K> {
  const compare = options.compare ?? defaultCompare;
  return options.order === 'desc' ? (a, b) => -compare(a, b) : compare;
}

/**
 * Index of the first element that does **not** sort before `target`.
 *
 * Ascending array: the first element `>= target`.
 * Descending array: the first element `<= target` — i.e. the newest entry at
 * or before a timestamp, which is the deployment-history lookup.
 *
 * Returns `items.length` when every element sorts before the target, so the
 * result doubles as the index at which `target` would be inserted to keep the
 * array sorted.
 */
export function lowerBound<T, K>(
  items: readonly T[],
  target: K,
  keyOf: (item: T) => K,
  options: SearchOptions<K> = {},
): number {
  const compare = effectiveComparator(options);
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    options.onProbe?.(mid);
    const item = items[mid];
    // `noUncheckedIndexedAccess` widens this to `T | undefined`; mid is always
    // in range, and a sparse array is treated as "sorts before" rather than
    // being allowed to reach the comparator.
    if (item === undefined || compare(keyOf(item), target) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Index of the first element that sorts strictly **after** `target`.
 *
 * Differs from `lowerBound` in one character — `<= 0` rather than `< 0` — and
 * that one character is what makes duplicate keys tractable: the two bounds
 * are the ends of the run of elements equal to the target. Two deployments
 * created in the same millisecond, or two metric samples sharing a timestamp,
 * are ordinary here rather than an edge case.
 */
export function upperBound<T, K>(
  items: readonly T[],
  target: K,
  keyOf: (item: T) => K,
  options: SearchOptions<K> = {},
): number {
  const compare = effectiveComparator(options);
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    options.onProbe?.(mid);
    const item = items[mid];
    if (item === undefined || compare(keyOf(item), target) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Index of an element whose key equals `target`, or -1.
 *
 * The lowest such index when there are several, because it is built on
 * `lowerBound` — a search that returned an arbitrary member of a run would
 * make "the first deployment of that second" unanswerable.
 */
export function binarySearch<T, K>(
  items: readonly T[],
  target: K,
  keyOf: (item: T) => K,
  options: SearchOptions<K> = {},
): number {
  const index = lowerBound(items, target, keyOf, options);
  if (index >= items.length) return -1;
  const item = items[index];
  if (item === undefined) return -1;
  const compare = effectiveComparator(options);
  return compare(keyOf(item), target) === 0 ? index : -1;
}

/**
 * The half-open slice `[start, end)` of elements whose keys fall within
 * `[from, to]` inclusive — two probes of the array, not a scan of it.
 *
 * `from`/`to` are given in **array order**, so on a descending array `from` is
 * the newer bound. Returns an empty range (`start === end`) rather than null
 * when nothing matches, so callers can `slice()` the result unconditionally.
 */
export function searchRange<T, K>(
  items: readonly T[],
  from: K,
  to: K,
  keyOf: (item: T) => K,
  options: SearchOptions<K> = {},
): { start: number; end: number } {
  const start = lowerBound(items, from, keyOf, options);
  const end = upperBound(items, to, keyOf, options);
  // `to` before `from` is a caller error, not a crash: clamp to empty.
  return { start, end: Math.max(start, end) };
}

/** `searchRange`, applied. The common case, spelled once. */
export function sliceRange<T, K>(
  items: readonly T[],
  from: K,
  to: K,
  keyOf: (item: T) => K,
  options: SearchOptions<K> = {},
): T[] {
  const { start, end } = searchRange(items, from, to, keyOf, options);
  return items.slice(start, end);
}

/**
 * The element in effect at `target`: the most recent one whose key does not
 * exceed it. `undefined` if `target` precedes every element.
 *
 * On the deployment history this is "which deployment was the current one at
 * 14:32?" — the *predecessor* form of the problem rather than the exact-match
 * form, which matters because the timestamp asked about will essentially never
 * be a timestamp any deployment actually has. `binarySearch` would answer
 * "nothing" to a perfectly reasonable question.
 *
 * The two orders reach the same element from opposite sides, and both pick the
 * newest of a tied run:
 *
 *  - descending (newest first): the *first* element `<= target` — `lowerBound`.
 *  - ascending: the *last* element `<= target` — one before `upperBound`.
 */
export function findAtOrBefore<T, K>(
  items: readonly T[],
  target: K,
  keyOf: (item: T) => K,
  options: SearchOptions<K> = {},
): { index: number; item: T } | undefined {
  const index =
    options.order === 'desc'
      ? lowerBound(items, target, keyOf, options)
      : upperBound(items, target, keyOf, options) - 1;
  if (index < 0 || index >= items.length) return undefined;
  const item = items[index];
  return item === undefined ? undefined : { index, item };
}
