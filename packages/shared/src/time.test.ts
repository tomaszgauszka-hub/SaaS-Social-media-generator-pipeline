import { describe, expect, it } from "vitest";
import { endOfPeriod, parseTimeOfDay, startOfPeriod, zonedParts, zonedTimeToUtc } from "./time.ts";

describe("time periods", () => {
  const now = new Date("2026-10-07T09:30:00Z"); // Wednesday

  it("computes UTC day/week/month starts", () => {
    expect(startOfPeriod(now, "day").toISOString()).toBe("2026-10-07T00:00:00.000Z");
    expect(startOfPeriod(now, "week").toISOString()).toBe("2026-10-05T00:00:00.000Z"); // Monday
    expect(startOfPeriod(now, "month").toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("computes period ends", () => {
    expect(endOfPeriod(now, "day").toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(endOfPeriod(now, "week").toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(endOfPeriod(now, "month").toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("respects time zones (Warsaw is UTC+2 in October)", () => {
    expect(startOfPeriod(now, "day", "Europe/Warsaw").toISOString()).toBe("2026-10-06T22:00:00.000Z");
    // Just after local midnight the local day has already rolled over
    const late = new Date("2026-10-06T22:30:00Z");
    expect(zonedParts(late, "Europe/Warsaw").day).toBe(7);
    expect(startOfPeriod(late, "day", "Europe/Warsaw").toISOString()).toBe("2026-10-06T22:00:00.000Z");
  });

  it("handles DST transitions (New York, Nov 1 2026 falls back)", () => {
    const start = startOfPeriod(new Date("2026-11-01T15:00:00Z"), "day", "America/New_York");
    expect(start.toISOString()).toBe("2026-11-01T04:00:00.000Z"); // EDT midnight
    const end = endOfPeriod(new Date("2026-11-01T15:00:00Z"), "day", "America/New_York");
    expect(end.toISOString()).toBe("2026-11-02T05:00:00.000Z"); // EST midnight (25h day)
  });

  it("converts wall clock to UTC", () => {
    const d = zonedTimeToUtc({ year: 2026, month: 10, day: 7, hour: 15, minute: 0 }, "Europe/Warsaw");
    expect(d.toISOString()).toBe("2026-10-07T13:00:00.000Z");
  });

  it("month boundary at year end", () => {
    expect(endOfPeriod(new Date("2026-12-15T00:00:00Z"), "month").toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  it("parses HH:mm", () => {
    expect(parseTimeOfDay("09:05")).toEqual({ hour: 9, minute: 5 });
    expect(() => parseTimeOfDay("24:00")).toThrow();
    expect(() => parseTimeOfDay("9:5")).toThrow();
  });
});
