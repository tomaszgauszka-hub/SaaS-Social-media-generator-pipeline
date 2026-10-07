/**
 * Time-zone aware period boundaries (budgets, schedules, dashboards) without a date library.
 * Uses Intl to read wall-clock parts in a zone and corrects the UTC offset iteratively (handles DST).
 */

export type Period = "day" | "week" | "month";

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday … 6 = Saturday
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(date: Date, timeZone = "UTC"): ZonedParts {
  const parts = formatter(timeZone).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** Offset (ms) of `timeZone` from UTC at the given instant: local wall time − UTC. */
export function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Convert a wall-clock time in `timeZone` to the corresponding UTC instant. */
export function zonedTimeToUtc(
  local: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  timeZone = "UTC",
): Date {
  const guess = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour ?? 0,
    local.minute ?? 0,
    local.second ?? 0,
  );
  let result = guess - timeZoneOffsetMs(new Date(guess), timeZone);
  // Second pass corrects instants that land on the other side of a DST change.
  const corrected = guess - timeZoneOffsetMs(new Date(result), timeZone);
  if (corrected !== result) result = corrected;
  return new Date(result);
}

export function startOfPeriod(now: Date, period: Period, timeZone = "UTC"): Date {
  const p = zonedParts(now, timeZone);
  switch (period) {
    case "day":
      return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day }, timeZone);
    case "week": {
      // ISO week: Monday 00:00 local time
      const daysSinceMonday = (p.weekday + 6) % 7;
      const mondayUtcNoon = new Date(Date.UTC(p.year, p.month - 1, p.day - daysSinceMonday, 12));
      return zonedTimeToUtc(
        {
          year: mondayUtcNoon.getUTCFullYear(),
          month: mondayUtcNoon.getUTCMonth() + 1,
          day: mondayUtcNoon.getUTCDate(),
        },
        timeZone,
      );
    }
    case "month":
      return zonedTimeToUtc({ year: p.year, month: p.month, day: 1 }, timeZone);
  }
}

export function endOfPeriod(now: Date, period: Period, timeZone = "UTC"): Date {
  const start = startOfPeriod(now, period, timeZone);
  const p = zonedParts(new Date(start.getTime() + 12 * 3600_000), timeZone);
  switch (period) {
    case "day": {
      const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1, 12));
      return zonedTimeToUtc(
        { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() },
        timeZone,
      );
    }
    case "week": {
      const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 7, 12));
      return zonedTimeToUtc(
        { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() },
        timeZone,
      );
    }
    case "month": {
      const next = new Date(Date.UTC(p.year, p.month, 1, 12));
      return zonedTimeToUtc({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: 1 }, timeZone);
    }
  }
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3600_000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** "HH:mm" → {hour, minute}; throws on malformed input. */
export function parseTimeOfDay(value: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) throw new RangeError(`Invalid time of day "${value}" (expected HH:mm)`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
