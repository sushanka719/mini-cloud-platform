import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lowerBound,
  upperBound,
  binarySearch,
  searchRange,
  findAtOrBefore,
} from '../dist/binary-search.js';

/**
 * Differential tests for `src/binary-search.ts`.
 *
 * Written against the built `dist/` as plain ESM so the suite needs no test
 * runner and no build step of its own — `node --test` has been in the runtime
 * since Node 18, and the alternative was adding Vitest to a package whose only
 * testable surface is one file of pure functions.
 *
 * The method is differential rather than example-based: every case is checked
 * against an obviously-correct linear scan over randomly generated arrays.
 * Hand-picked examples would have been written by the same person who wrote
 * the off-by-one, which is exactly the bug binary search is famous for.
 * Duplicate keys are over-represented on purpose (the generated key domain is
 * far smaller than the array) because that is where `lowerBound` and
 * `upperBound` differ and where a naive implementation returns "some match"
 * instead of the first one.
 */

const id = (x) => x;

// --- obviously-correct references -------------------------------------------
const refLowerAsc = (a, t) => { let i = 0; while (i < a.length && a[i] < t) i++; return i; };
const refUpperAsc = (a, t) => { let i = 0; while (i < a.length && a[i] <= t) i++; return i; };
const refLowerDesc = (a, t) => { let i = 0; while (i < a.length && a[i] > t) i++; return i; };
const refUpperDesc = (a, t) => { let i = 0; while (i < a.length && a[i] >= t) i++; return i; };
const refAtOrBeforeAsc = (a, t) => { let r = -1; for (let i = 0; i < a.length; i++) if (a[i] <= t) r = i; return r; };
const refAtOrBeforeDesc = (a, t) => { for (let i = 0; i < a.length; i++) if (a[i] <= t) return i; return -1; };

/** Deterministic LCG, so a failure is reproducible rather than "sometimes". */
let rng = 12345;
const rand = (n) => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) % n;

test('matches a linear scan on random arrays, ascending and descending', () => {
  let cases = 0;
  for (let trial = 0; trial < 4000; trial++) {
    const n = rand(40);
    const domain = 1 + rand(8); // small domain => many duplicate keys
    const asc = Array.from({ length: n }, () => rand(domain)).sort((x, y) => x - y);
    const desc = [...asc].reverse();
    for (let t = -1; t <= domain; t++) {
      const where = `n=${n} t=${t} [${asc}]`;
      assert.equal(lowerBound(asc, t, id), refLowerAsc(asc, t), `lowerBound asc ${where}`);
      assert.equal(upperBound(asc, t, id), refUpperAsc(asc, t), `upperBound asc ${where}`);
      assert.equal(lowerBound(desc, t, id, { order: 'desc' }), refLowerDesc(desc, t), `lowerBound desc ${where}`);
      assert.equal(upperBound(desc, t, id, { order: 'desc' }), refUpperDesc(desc, t), `upperBound desc ${where}`);
      // binarySearch must find the *first* of a run, hence indexOf.
      assert.equal(binarySearch(asc, t, id), asc.indexOf(t), `binarySearch asc ${where}`);
      assert.equal(binarySearch(desc, t, id, { order: 'desc' }), desc.indexOf(t), `binarySearch desc ${where}`);
      assert.equal(findAtOrBefore(asc, t, id)?.index ?? -1, refAtOrBeforeAsc(asc, t), `atOrBefore asc ${where}`);
      assert.equal(findAtOrBefore(desc, t, id, { order: 'desc' })?.index ?? -1, refAtOrBeforeDesc(desc, t), `atOrBefore desc ${where}`);
      const to = t + 1 + rand(3);
      const { start, end } = searchRange(asc, t, to, id);
      assert.deepEqual(asc.slice(start, end), asc.filter((v) => v >= t && v <= to), `searchRange ${where}..${to}`);
      cases += 9;
    }
  }
  assert.ok(cases > 100_000, `expected a meaningful number of cases, ran ${cases}`);
});

test('degenerate inputs do not need a special case at the call site', () => {
  assert.equal(lowerBound([], 5, id), 0);
  assert.equal(binarySearch([], 5, id), -1);
  assert.equal(findAtOrBefore([], 5, id), undefined);
  assert.equal(binarySearch([7], 7, id), 0);
  assert.equal(binarySearch([7], 8, id), -1);
  assert.equal(findAtOrBefore([5, 6], 4, id), undefined, 'target before every element');
  assert.equal(findAtOrBefore([5, 6], 99, id)?.index, 1, 'target after every element');
  assert.equal(findAtOrBefore([6, 5], 4, id, { order: 'desc' }), undefined);
  assert.equal(lowerBound([1, 2, 3], 9, id), 3, 'returns the insertion point past the end');
  assert.equal(lowerBound([4, 4, 4, 4], 4, id), 0, 'all-duplicates: first');
  assert.equal(upperBound([4, 4, 4, 4], 4, id), 4, 'all-duplicates: past the last');
  const inverted = searchRange([1, 2, 3], 3, 1, id);
  assert.equal(inverted.start, inverted.end, 'to before from yields an empty, not negative, range');
});

test('answers the deployment-history question it was written for', () => {
  // Exactly the shape `GET /deployments` returns: newest first.
  const deployments = [
    { id: 'd4', createdAt: '2026-09-08T14:40:00.000Z' },
    { id: 'd3', createdAt: '2026-09-08T14:32:00.000Z' },
    { id: 'd2', createdAt: '2026-09-08T14:10:00.000Z' },
    { id: 'd1', createdAt: '2026-09-08T13:00:00.000Z' },
  ];
  const keyOf = (d) => Date.parse(d.createdAt);
  const liveAt = (iso) =>
    findAtOrBefore(deployments, Date.parse(iso), keyOf, { order: 'desc' })?.item.id;

  assert.equal(liveAt('2026-09-08T14:35:00.000Z'), 'd3', 'between two deployments');
  assert.equal(liveAt('2026-09-08T14:40:00.000Z'), 'd4', 'exactly on a boundary');
  assert.equal(liveAt('2026-09-08T14:09:59.999Z'), 'd1', 'one millisecond before one');
  assert.equal(liveAt('2027-01-01T00:00:00.000Z'), 'd4', 'after the whole history');
  assert.equal(liveAt('2026-09-08T12:00:00.000Z'), undefined, 'before the whole history');
});

test('probe count stays within ceil(log2(n+1)) — the O(log n) claim, checked', () => {
  for (const n of [1, 10, 100, 1000, 10_000, 100_000]) {
    const arr = Array.from({ length: n }, (_, i) => i * 2); // gaps, so misses are exercised
    let worst = 0;
    for (let t = -1; t <= n * 2; t += Math.max(1, Math.floor(n / 97))) {
      let probes = 0;
      lowerBound(arr, t, id, { onProbe: () => probes++ });
      worst = Math.max(worst, probes);
    }
    assert.ok(
      worst <= Math.ceil(Math.log2(n + 1)),
      `n=${n}: worst ${worst} probes exceeds ceil(log2(n+1))=${Math.ceil(Math.log2(n + 1))}`,
    );
  }
});
