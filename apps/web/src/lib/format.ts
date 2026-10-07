import { formatUsd, type Micros } from "@cre/shared";

export const usd = (micros: Micros | null | undefined, precision?: number) =>
  micros === null || micros === undefined
    ? "—"
    : formatUsd(micros, precision !== undefined ? { precision } : {});

export const num = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-US");

export const pct = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;

export function dateTime(d: Date | null | undefined, timeZone = "UTC"): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function date(d: Date | null | undefined, timeZone = "UTC"): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
}

export function relative(d: Date | null | undefined, now = new Date()): string {
  if (!d) return "—";
  const s = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(s);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 60) return rtf.format(s, "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86_400), "day");
}

export function seconds(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`;
}

export const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|_)(\w)/g, (_, sep: string, c: string) => `${sep ? " " : ""}${c.toUpperCase()}`);
