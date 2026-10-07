import { addDays, startOfPeriod } from "@cre/shared";
import { env } from "./db";

export const RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const;
export type RangeKey = keyof typeof RANGES;

export function parseRange(value: string | string[] | undefined): RangeKey {
  return typeof value === "string" && value in RANGES ? (value as RangeKey) : "30d";
}

/** [from, to) covering the last N local days including today. */
export function periodFor(range: RangeKey, timeZone: string, now = new Date()) {
  const today = startOfPeriod(now, "day", timeZone);
  const to = addDays(today, 1);
  const from = addDays(today, -(RANGES[range] - 1));
  return { from, to, today, days: RANGES[range] };
}

/** Simulated (mock) analytics are shown only while running in mock social mode. */
export function includeSimulated(): boolean {
  return env().MOCK_SOCIAL;
}

export function dayLabels(from: Date, days: number, timeZone: string): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    out.push({
      key: new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d),
      label: new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" }).format(d),
    });
  }
  return out;
}
