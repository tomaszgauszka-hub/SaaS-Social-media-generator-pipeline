"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/**
 * Small SVG chart kit following the data-viz method: thin marks, hairline solid grid, one y-axis, legend for
 * 2+ series, selective direct labels, crosshair/per-mark tooltips (pointer + keyboard) and a table view.
 * Palette = validated reference slots (blue, orange, aqua) on the white card surface.
 */
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a"] as const;
const INK = {
  primary: "#0b0b0b",
  secondary: "#52514e",
  muted: "#898781",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  surface: "#ffffff",
};

export type Unit = "usd" | "count";

export function formatValue(v: number, unit: Unit, compact = false): string {
  if (unit === "usd") {
    const usd = v / 1_000_000;
    const abs = Math.abs(usd);
    if (compact && abs >= 1000) return `${usd < 0 ? "-" : ""}$${(abs / 1000).toFixed(1)}K`;
    return `${usd < 0 ? "-" : ""}$${abs.toLocaleString("en-US", { minimumFractionDigits: abs > 0 && abs < 1 ? 2 : compact ? 0 : 2, maximumFractionDigits: 2 })}`;
  }
  if (compact && Math.abs(v) >= 10_000) return `${(v / 1000).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
}

function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let t = 0; t <= max + step * 0.001; t += step) ticks.push(t);
  if ((ticks.at(-1) ?? 0) < max) ticks.push((ticks.at(-1) ?? 0) + step);
  return ticks;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function TableView({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: string[];
  rows: (string | number)[][];
}) {
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-zinc-500 select-none hover:text-zinc-800">Table view</summary>
      <div className="mt-2 max-h-64 overflow-auto">
        <table className="min-w-full text-left tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h} className="px-2 py-1 font-semibold text-zinc-500">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-zinc-100">
                {r.map((c, j) => (
                  <td key={j} className="px-2 py-1">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export interface LineSeries {
  key: string;
  label: string;
  values: number[];
}

const PLOT_H = 200;
const AXIS_H = 24;
const PAD = { top: 12, right: 56, left: 52 };

/** Multi-series line chart over categorical x labels (days). One y-axis; same unit for every series. */
export function LineChart({
  title,
  labels,
  series,
  unit,
}: {
  title: string;
  labels: string[];
  series: LineSeries[];
  unit: Unit;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const tipId = useId();
  const n = labels.length;
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(max);
  const top = ticks.at(-1) || 1;
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const x = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD.top + PLOT_H - (v / top) * PLOT_H;
  const path = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");

  const ends = series.map((s, k) => ({ k, y: y(s.values.at(-1) ?? 0), v: s.values.at(-1) ?? 0 }));
  const collide = ends.some((a, i) => ends.some((b, j) => i < j && Math.abs(a.y - b.y) < 14));

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = n <= 1 ? 0 : Math.round((px / rect.width) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n) - 1));
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  };
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 64))));

  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-zinc-800">{title}</span>
        {series.length > 1 ? (
          <span className="flex flex-wrap gap-3 text-xs" style={{ color: INK.secondary }}>
            {series.map((s, k) => (
              <span key={s.key} className="inline-flex items-center gap-1.5">
                <svg width="16" height="8" aria-hidden>
                  <line
                    x1="1"
                    y1="4"
                    x2="15"
                    y2="4"
                    stroke={SERIES[k % SERIES.length]}
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                {s.label}
              </span>
            ))}
          </span>
        ) : null}
      </figcaption>
      <div ref={ref} className="relative">
        {width > 0 ? (
          <svg
            width={width}
            height={PLOT_H + PAD.top + AXIS_H}
            role="img"
            aria-label={`${title}. Use left and right arrow keys to read values.`}
            aria-describedby={hover !== null ? tipId : undefined}
            tabIndex={0}
            onKeyDown={onKey}
            onBlur={() => setHover(null)}
            className="block overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-brand-100"
          >
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={PAD.left}
                  x2={PAD.left + plotW}
                  y1={y(t)}
                  y2={y(t)}
                  stroke={t === 0 ? INK.axis : INK.grid}
                  strokeWidth="1"
                />
                <text
                  x={PAD.left - 8}
                  y={y(t)}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize="11"
                  fill={INK.muted}
                  className="tabular-nums"
                >
                  {formatValue(t, unit, true)}
                </text>
              </g>
            ))}
            {labels.map((l, i) =>
              (n - 1 - i) % labelEvery === 0 ? (
                <text
                  key={l}
                  x={x(i)}
                  y={PAD.top + PLOT_H + 16}
                  textAnchor="middle"
                  fontSize="11"
                  fill={INK.muted}
                >
                  {l}
                </text>
              ) : null,
            )}
            {series.length === 1 && series[0] ? (
              <path
                d={`${path(series[0].values)}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`}
                fill={SERIES[0]}
                opacity="0.1"
              />
            ) : null}
            {series.map((s, k) => (
              <path
                key={s.key}
                d={path(s.values)}
                fill="none"
                stroke={SERIES[k % SERIES.length]}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {ends.map((e) => (
              <circle
                key={e.k}
                cx={x(n - 1)}
                cy={e.y}
                r="4"
                fill={SERIES[e.k % SERIES.length]}
                stroke={INK.surface}
                strokeWidth="2"
              />
            ))}
            {!collide
              ? ends.map((e) => (
                  <text
                    key={e.k}
                    x={x(n - 1) + 8}
                    y={e.y}
                    dy="0.32em"
                    fontSize="11"
                    fontWeight="600"
                    fill={INK.primary}
                    className="tabular-nums"
                  >
                    {formatValue(e.v, unit, true)}
                  </text>
                ))
              : null}
            {hover !== null ? (
              <g pointerEvents="none">
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={PAD.top}
                  y2={PAD.top + PLOT_H}
                  stroke={INK.muted}
                  strokeWidth="1"
                />
                {series.map((s, k) => (
                  <circle
                    key={s.key}
                    cx={x(hover)}
                    cy={y(s.values[hover] ?? 0)}
                    r="4"
                    fill={SERIES[k % SERIES.length]}
                    stroke={INK.surface}
                    strokeWidth="2"
                  />
                ))}
              </g>
            ) : null}
            <rect
              x={PAD.left}
              y={PAD.top}
              width={plotW}
              height={PLOT_H}
              fill="transparent"
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
        ) : (
          <div style={{ height: PLOT_H + PAD.top + AXIS_H }} />
        )}
        {hover !== null && width > 0 ? (
          <div
            id={tipId}
            role="status"
            className="pointer-events-none absolute z-10 min-w-36 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg"
            style={{ left: Math.min(Math.max(0, x(hover) + 12), width - 160), top: 4 }}
          >
            <div className="mb-1" style={{ color: INK.secondary }}>
              {labels[hover]}
            </div>
            {series.map((s, k) => (
              <div key={s.key} className="flex items-center gap-2">
                <svg width="12" height="6" aria-hidden>
                  <line
                    x1="1"
                    y1="3"
                    x2="11"
                    y2="3"
                    stroke={SERIES[k % SERIES.length]}
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                <strong className="tabular-nums" style={{ color: INK.primary }}>
                  {formatValue(s.values[hover] ?? 0, unit)}
                </strong>
                <span style={{ color: INK.secondary }}>{s.label}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <TableView
        caption={title}
        head={["Day", ...series.map((s) => s.label)]}
        rows={labels.map((l, i) => [l, ...series.map((s) => formatValue(s.values[i] ?? 0, unit))])}
      />
    </figure>
  );
}

/** Single-series column chart (one hue, slot 1). Per-bar hover/focus tooltip; only the maximum is labelled. */
export function ColumnChart({
  title,
  labels,
  values,
  unit,
}: {
  title: string;
  labels: string[];
  values: number[];
  unit: Unit;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const max = Math.max(0, ...values);
  const ticks = niceTicks(max);
  const top = ticks.at(-1) || 1;
  const plotW = Math.max(10, width - PAD.left - 16);
  const band = plotW / Math.max(1, n);
  const barW = Math.max(2, Math.min(24, band - 2));
  const y = (v: number) => PAD.top + PLOT_H - (v / top) * PLOT_H;
  const maxIndex = values.indexOf(max);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 64))));

  const bar = (i: number, v: number) => {
    const x0 = PAD.left + i * band + (band - barW) / 2;
    const h = Math.max(0, y(0) - y(v));
    if (h <= 0) return "";
    const r = Math.min(4, h, barW / 2);
    const yt = y(v);
    return `M${x0},${y(0)}V${yt + r}Q${x0},${yt} ${x0 + r},${yt}H${x0 + barW - r}Q${x0 + barW},${yt} ${x0 + barW},${yt + r}V${y(0)}Z`;
  };

  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 text-sm font-semibold text-zinc-800">{title}</figcaption>
      <div ref={ref} className="relative">
        {width > 0 ? (
          <svg
            width={width}
            height={PLOT_H + PAD.top + AXIS_H}
            role="img"
            aria-label={title}
            className="block overflow-visible"
          >
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={PAD.left}
                  x2={PAD.left + plotW}
                  y1={y(t)}
                  y2={y(t)}
                  stroke={t === 0 ? INK.axis : INK.grid}
                  strokeWidth="1"
                />
                <text
                  x={PAD.left - 8}
                  y={y(t)}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize="11"
                  fill={INK.muted}
                  className="tabular-nums"
                >
                  {formatValue(t, unit, true)}
                </text>
              </g>
            ))}
            {values.map((v, i) => (
              <g key={labels[i]}>
                <path d={bar(i, v)} fill={SERIES[0]} opacity={hover === null || hover === i ? 1 : 0.55} />
                <rect
                  x={PAD.left + i * band}
                  y={PAD.top}
                  width={band}
                  height={PLOT_H}
                  fill="transparent"
                  tabIndex={0}
                  role="img"
                  aria-label={`${labels[i]}: ${formatValue(v, unit)}`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  className="outline-none"
                />
              </g>
            ))}
            {max > 0 && maxIndex >= 0 ? (
              <text
                x={PAD.left + maxIndex * band + band / 2}
                y={y(max) - 6}
                textAnchor="middle"
                fontSize="11"
                fontWeight="600"
                fill={INK.primary}
                className="tabular-nums"
              >
                {formatValue(max, unit, true)}
              </text>
            ) : null}
            {labels.map((l, i) =>
              (n - 1 - i) % labelEvery === 0 ? (
                <text
                  key={l}
                  x={PAD.left + i * band + band / 2}
                  y={PAD.top + PLOT_H + 16}
                  textAnchor="middle"
                  fontSize="11"
                  fill={INK.muted}
                >
                  {l}
                </text>
              ) : null,
            )}
          </svg>
        ) : (
          <div style={{ height: PLOT_H + PAD.top + AXIS_H }} />
        )}
        {hover !== null && width > 0 ? (
          <div
            role="status"
            className="pointer-events-none absolute z-10 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg"
            style={{
              left: Math.min(Math.max(0, PAD.left + hover * band + band / 2 + 8), width - 140),
              top: 4,
            }}
          >
            <strong className="block tabular-nums" style={{ color: INK.primary }}>
              {formatValue(values[hover] ?? 0, unit)}
            </strong>
            <span style={{ color: INK.secondary }}>{labels[hover]}</span>
          </div>
        ) : null}
      </div>
      <TableView
        caption={title}
        head={["Day", title]}
        rows={labels.map((l, i) => [l, formatValue(values[i] ?? 0, unit)])}
      />
    </figure>
  );
}
