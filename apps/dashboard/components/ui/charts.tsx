'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Point } from '@/lib/metrics';

/**
 * The chart vocabulary: a time-series plot, a bar list, and a stat tile.
 *
 * Hand-rolled SVG rather than a charting library, for the same reason the
 * Prometheus renderer is hand-rolled: what a library would add here (a plugin
 * system, a dozen chart types, an animation engine) is weight we don't use,
 * and what we do need is a path string and a hover layer.
 *
 * Three rules these components exist to enforce, so no caller can break them:
 *
 *  - **One y-scale per chart.** There is no second-axis prop. Two measures of
 *    different magnitude are two charts, because aligning two scales on one
 *    plot invents a correlation the data does not contain.
 *  - **Color follows the entity.** A series carries its own `color`, assigned
 *    by what it *is*, so hiding one series never repaints the others.
 *  - **Identity is never colour alone.** Two or more series always render a
 *    legend; every series gets an end label when they fit; every value is also
 *    reachable in the table view and the tooltip.
 */

/**
 * The plot palette, validated against this dashboard's surface (`#0d0f16`) for
 * the lightness band, chroma floor, colour-vision separation and 3:1 contrast.
 *
 * Deliberately *not* the emerald/sky/amber the rest of the UI uses for badges:
 * those are status colours (live / building / failed) and a status colour must
 * never impersonate a series. Three slots, in fixed order — a fourth is a
 * signal to facet into small multiples rather than to invent a hue.
 */
export const VIZ = {
  surface: '#0d0f16',
  grid: '#1c202b',
  /** Categorical slots, assigned in this order and never cycled. */
  series: ['#3987e5', '#199e70', '#c98500'] as const,
  /** Magnitude, single hue, light → dark. */
  sequential: ['#5598e7', '#3987e5', '#2a78d6', '#256abf'] as const,
  /** Status, reserved: never used as a series colour. */
  status: { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b' },
  ink: { primary: '#e6e8ef', secondary: '#8b90a3', muted: '#6e7387' },
} as const;

export type ChartSeries = {
  /** Stable identity — also what keeps a colour attached to an entity. */
  key: string;
  label: string;
  color: string;
  points: Point[];
};

// --- geometry ---------------------------------------------------------------

/** Rounds an axis maximum up to 1/2/5×10ⁿ, so ticks read as round numbers. */
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * Tracks the element's width so the SVG can be laid out in real pixels.
 *
 * A `viewBox` with `preserveAspectRatio="none"` would be one line instead of
 * this, and it scales the strokes with the box — 2px lines become 3.4px on a
 * wide screen and the text stretches. Measuring keeps every spec honest.
 */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => {
      observer.disconnect();
    };
  }, []);

  return [ref, width];
}

// --- time series ------------------------------------------------------------

export type TimeChartProps = {
  series: ChartSeries[];
  /** Plot height in px, excluding the legend. */
  height?: number;
  /** Formats a value for the axis, the tooltip and the end labels. */
  format?: (value: number) => string;
  /** Forces the top of the scale — e.g. 100 for a percentage. */
  yMax?: number;
  /** Suppresses the legend and axis labels, for a tile-sized plot. */
  compact?: boolean;
  /** What to say before the first sample arrives. */
  empty?: string;
};

export function TimeChart({
  series,
  height = 140,
  format = (value) => value.toFixed(1),
  yMax,
  compact = false,
  empty = 'Waiting for the first sample…',
}: TimeChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);

  const plot = useMemo(() => {
    const points = series.flatMap((s) => s.points);
    if (points.length === 0) return null;

    let tMin = Infinity;
    let tMax = -Infinity;
    let vMax = 0;
    for (const point of points) {
      if (point.t < tMin) tMin = point.t;
      if (point.t > tMax) tMax = point.t;
      if (point.v > vMax) vMax = point.v;
    }
    // A single sample, or a series that has not moved, still needs a non-zero
    // span or every x collapses onto one pixel.
    if (tMax - tMin < 1000) tMax = tMin + 1000;
    const top = yMax ?? niceCeil(vMax === 0 ? 1 : vMax * 1.1);
    return { tMin, tMax, top };
  }, [series, yMax]);

  /**
   * Axis ticks, de-duplicated by their *rendered* label.
   *
   * Two rules, both learned from a chart that read wrong:
   *
   *  - a domain of 0..1 (an idle queue) with three ticks formats as "0", "1",
   *    "1" — the midpoint rounds into its neighbour and the axis appears to
   *    repeat itself. Small integer domains get two ticks instead of three.
   *  - anything that still collides after that keeps its gridline and loses
   *    its text, because a duplicated number is worse than a missing one.
   */
  const ticks = (() => {
    if (!plot || compact) return [] as { value: number; label: string }[];
    const raw = plot.top <= 2 ? [0, plot.top] : [0, plot.top / 2, plot.top];
    const seen = new Set<string>();
    return raw
      .map((value) => ({ value, label: format(value) }))
      .filter((tick) => {
        if (seen.has(tick.label)) return false;
        seen.add(tick.label);
        return true;
      });
  })();

  /**
   * The left gutter is measured from the widest tick label, not fixed.
   *
   * A fixed gutter is fine until the axis reads "190.7 MiB", at which point
   * the text runs off the left edge of the SVG and is clipped — a label that
   * doesn't fit must be given room, never cropped. 5.8px/char is a safe
   * estimate for digits in a 10px system sans.
   */
  const gutter = ticks.reduce((widest, tick) => Math.max(widest, tick.label.length), 0) * 5.8 + 10;

  const padding = compact
    ? { top: 6, right: 6, bottom: 6, left: 6 }
    : { top: 10, right: 56, bottom: 18, left: Math.max(28, gutter) };

  const innerWidth = Math.max(0, width - padding.left - padding.right);
  const innerHeight = Math.max(0, height - padding.top - padding.bottom);

  const scaleX = (t: number): number => {
    if (!plot) return padding.left;
    const ratio = (t - plot.tMin) / (plot.tMax - plot.tMin);
    return padding.left + ratio * innerWidth;
  };

  const scaleY = (v: number): number => {
    if (!plot) return padding.top + innerHeight;
    const ratio = Math.min(1, Math.max(0, v / plot.top));
    return padding.top + innerHeight - ratio * innerHeight;
  };

  /**
   * Which series get a direct end label.
   *
   * Direct labels work *because* they are sparing. Three series sitting on
   * zero (an idle queue) put three identical numbers on the same pixel, which
   * reads as a rendering bug rather than as data — so a label is dropped when
   * another series has already claimed that row. The dot still marks every
   * series' end, and the legend and tooltip carry the values that lost.
   */
  const endLabels = (() => {
    if (compact || !plot) return new Set<string>();
    const claimed: number[] = [];
    const allowed = new Set<string>();
    for (const s of series) {
      const last = s.points[s.points.length - 1];
      if (!last) continue;
      const y = scaleY(last.v);
      if (claimed.some((other) => Math.abs(other - y) < 11)) continue;
      claimed.push(y);
      allowed.add(s.key);
    }
    return allowed;
  })();

  if (series.every((s) => s.points.length === 0)) {
    return (
      <div
        ref={ref}
        style={{ height }}
        className="flex items-center justify-center text-xs text-[#6e7387]"
      >
        {empty}
      </div>
    );
  }

  /** The point of each series nearest the hovered instant. */
  const readout =
    hover === null
      ? null
      : series
          .map((s) => {
            let nearest: Point | null = null;
            let best = Infinity;
            for (const point of s.points) {
              const distance = Math.abs(point.t - hover.t);
              if (distance < best) {
                best = distance;
                nearest = point;
              }
            }
            return nearest ? { series: s, point: nearest } : null;
          })
          .filter((row): row is { series: ChartSeries; point: Point } => row !== null);

  return (
    <div ref={ref} className="relative">
      <svg
        width={width || 0}
        height={height}
        role="img"
        aria-label={`Time series: ${series.map((s) => s.label).join(', ')}`}
        className="block touch-none"
        onPointerMove={(event) => {
          if (!plot || innerWidth <= 0) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const x = Math.min(
            padding.left + innerWidth,
            Math.max(padding.left, event.clientX - bounds.left),
          );
          const ratio = (x - padding.left) / innerWidth;
          setHover({ x, t: plot.tMin + ratio * (plot.tMax - plot.tMin) });
        }}
        onPointerLeave={() => setHover(null)}
      >
        {/* Gridlines: hairline, solid, one step off the surface. The axis
            carries the values the end labels don't. */}
        {ticks.map((tick) => {
          const y = scaleY(tick.value);
          return (
            <g key={tick.label}>
              <line
                x1={padding.left}
                x2={padding.left + innerWidth}
                y1={y}
                y2={y}
                stroke={VIZ.grid}
                strokeWidth={1}
              />
              <text
                x={padding.left - 6}
                y={y + 3}
                textAnchor="end"
                className="fill-[#6e7387] text-[10px] [font-variant-numeric:tabular-nums]"
              >
                {tick.label}
              </text>
            </g>
          );
        })}

        {series.map((s) => {
          if (s.points.length === 0) return null;
          const line = s.points
            .map((point, index) => `${index === 0 ? 'M' : 'L'}${String(scaleX(point.t))},${String(scaleY(point.v))}`)
            .join(' ');
          const first = s.points[0];
          const last = s.points[s.points.length - 1];
          if (!first || !last) return null;
          const baseline = padding.top + innerHeight;
          const area = `${line} L${String(scaleX(last.t))},${String(baseline)} L${String(scaleX(first.t))},${String(baseline)} Z`;

          return (
            <g key={s.key}>
              {/* Area is a wash, not a block: at 10% it reads as weight under
                  the line without hiding a series drawn behind it. */}
              <path d={area} fill={s.color} fillOpacity={0.1} />
              <path
                d={line}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {/* End marker: 8px, with a 2px surface ring so it stays legible
                  where two series cross at the right edge. */}
              <circle
                cx={scaleX(last.t)}
                cy={scaleY(last.v)}
                r={4}
                fill={s.color}
                stroke={VIZ.surface}
                strokeWidth={2}
              />
              {endLabels.has(s.key) && (
                <text
                  x={scaleX(last.t) + 8}
                  y={scaleY(last.v) + 3}
                  className="fill-[#8b90a3] text-[10px] [font-variant-numeric:tabular-nums]"
                >
                  {format(last.v)}
                </text>
              )}
            </g>
          );
        })}

        {/* The crosshair finds the X, so the reader aims at an instant rather
            than at a 2px line. */}
        {hover && (
          <line
            x1={hover.x}
            x2={hover.x}
            y1={padding.top}
            y2={padding.top + innerHeight}
            stroke={VIZ.ink.muted}
            strokeWidth={1}
          />
        )}
        {hover &&
          readout?.map((row) => (
            <circle
              key={row.series.key}
              cx={scaleX(row.point.t)}
              cy={scaleY(row.point.v)}
              r={4}
              fill={row.series.color}
              stroke={VIZ.surface}
              strokeWidth={2}
            />
          ))}
      </svg>

      {hover && readout && readout.length > 0 && (
        <div
          role="status"
          style={{
            left: Math.min(Math.max(8, hover.x + 10), Math.max(8, width - 150)),
            top: 4,
          }}
          className="pointer-events-none absolute z-10 min-w-[8rem] rounded-lg border border-[#2c3142] bg-[#0d0f16]/95 px-2.5 py-2 shadow-lg"
        >
          <p className="text-[10px] text-[#6e7387]">
            {new Date(readout[0]?.point.t ?? Date.now()).toLocaleTimeString()}
          </p>
          {readout.map((row) => (
            <p key={row.series.key} className="mt-1 flex items-center gap-2 text-[11px]">
              {/* A short stroke keys the series; at tooltip density a filled
                  box is data-weight ink doing a label's job. */}
              <span
                aria-hidden
                className="inline-block h-[2px] w-3 shrink-0 rounded-full"
                style={{ backgroundColor: row.series.color }}
              />
              {/* Value leads, label follows: the reader has the series and
                  wants the number. */}
              <span className="font-medium text-[#e6e8ef] [font-variant-numeric:tabular-nums]">
                {format(row.point.v)}
              </span>
              <span className="truncate text-[#8b90a3]">{row.series.label}</span>
            </p>
          ))}
        </div>
      )}

      {!compact && series.length > 1 && (
        <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5 text-[11px] text-[#8b90a3]">
              <span
                aria-hidden
                className="inline-block h-[2px] w-3.5 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- bar list ---------------------------------------------------------------

export type BarDatum = { key: string; label: string; value: number; color?: string };

/**
 * Horizontal bars for a labelled magnitude — failures by code, deployments by
 * status.
 *
 * Horizontal rather than vertical because the labels are words (`BUILD_FAILED`,
 * `creating_container`) and rotated axis text is unreadable. One colour for
 * every bar unless the caller passes one: colouring each bar darker-where-
 * bigger would double-encode the length as hue and burn the only free channel
 * on information the bar already shows.
 */
export function BarList({
  data,
  format = (value) => value.toLocaleString(),
  color = VIZ.sequential[1],
  empty = 'Nothing to show.',
}: {
  data: BarDatum[];
  format?: (value: number) => string;
  color?: string;
  empty?: string;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const max = data.reduce((peak, datum) => Math.max(peak, datum.value), 0);

  if (data.length === 0) return <p className="py-4 text-xs text-[#6e7387]">{empty}</p>;

  return (
    <ul className="space-y-2">
      {data.map((datum) => {
        const share = max > 0 ? (datum.value / max) * 100 : 0;
        const active = hovered === datum.key;
        return (
          <li
            key={datum.key}
            // The hit target is the whole row, not the painted bar: a 6px bar
            // is a pinpoint nobody hits reliably.
            tabIndex={0}
            onPointerEnter={() => setHovered(datum.key)}
            onPointerLeave={() => setHovered(null)}
            onFocus={() => setHovered(datum.key)}
            onBlur={() => setHovered(null)}
            className="group cursor-default rounded outline-none focus-visible:ring-1 focus-visible:ring-[#3a4056]"
            title={`${datum.label}: ${format(datum.value)}`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate font-mono text-[11px] text-[#8b90a3]">{datum.label}</span>
              <span className="shrink-0 text-[11px] text-[#e6e8ef] [font-variant-numeric:tabular-nums]">
                {format(datum.value)}
              </span>
            </div>
            {/* Track is a step of the same ramp, so state reads across the
                whole bar; the bar itself is capped well under 24px. */}
            <div className="mt-1 h-1.5 w-full rounded-full bg-[#151925]">
              <div
                className="h-1.5 rounded-r-[4px] transition-[width,opacity] duration-500"
                style={{
                  width: `${String(Math.max(share, datum.value > 0 ? 2 : 0))}%`,
                  backgroundColor: datum.color ?? color,
                  opacity: active ? 1 : 0.85,
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// --- stat tile --------------------------------------------------------------

/**
 * A number that is the whole story, optionally with its own trend.
 *
 * The right form far more often than a chart is: "queue waiting: 3" is a
 * number, and drawing it as a one-bar bar chart would be decoration.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = 'text-[#e6e8ef]',
  trend,
  trendColor = VIZ.series[0],
  trendFormat,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
  trend?: Point[];
  trendColor?: string;
  trendFormat?: (value: number) => string;
}) {
  return (
    <div className="rounded-lg border border-[#232734] bg-[#0d0f16] px-3 py-3">
      <p className="text-[11px] text-[#6e7387]">{label}</p>
      {/* Proportional figures, not tabular: at this size tabular-nums makes a
          number like 121 look loose. Columns of numbers get tabular; a
          standalone value does not. */}
      <p className={`mt-1 text-xl font-semibold ${tone}`}>{value}</p>
      {trend && trend.length > 1 && (
        <div className="mt-1.5">
          <TimeChart
            series={[{ key: label, label, color: trendColor, points: trend }]}
            height={28}
            compact
            format={trendFormat ?? ((v) => v.toFixed(1))}
          />
        </div>
      )}
      {hint && <p className="mt-1 text-[10px] text-[#6e7387]">{hint}</p>}
    </div>
  );
}

// --- table view -------------------------------------------------------------

/**
 * The table behind a chart.
 *
 * Present so no value is reachable *only* by hovering — the accessibility
 * floor for every chart on the page, and incidentally the thing you want when
 * copying a number into a report.
 */
export function DataTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: (string | number)[][];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-[10px] uppercase tracking-wide text-[#6e7387]">
          <tr>
            {columns.map((column) => (
              <th key={column} className="pb-1.5 pr-4 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#1c202b]">
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className="py-1.5 pr-4 text-[#8b90a3] [font-variant-numeric:tabular-nums]"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
