import { addMinutes, parseTimeOfDay, zonedParts, zonedTimeToUtc } from "@cre/shared";

/**
 * Publication slot finder. Brands configure recurring slots per platform (e.g. TikTok 12:00, Instagram 15:00,
 * Facebook 18:00 in the brand's time zone). Approved content takes the earliest free slot after a lead time.
 */
export interface SlotRule {
  platform: string;
  /** 0 = Sunday … 6 = Saturday; null = every day */
  dayOfWeek: number | null;
  timeOfDay: string;
  socialAccountId?: string | null;
}

export interface NextSlotOptions {
  platform: string;
  timeZone: string;
  from: Date;
  minLeadMinutes: number;
  horizonDays: number;
  /** already-booked times for the same account/platform */
  taken: Date[];
  /** minimum spacing between two posts on the same account */
  minSpacingMinutes?: number;
}

export function nextSlot(rules: readonly SlotRule[], opts: NextSlotOptions): Date | null {
  const applicable = rules.filter((r) => r.platform === opts.platform);
  if (applicable.length === 0) return null;
  const earliest = addMinutes(opts.from, opts.minLeadMinutes);
  const spacing = (opts.minSpacingMinutes ?? 60) * 60_000;
  const candidates: Date[] = [];
  for (let offset = 0; offset <= opts.horizonDays; offset++) {
    // noon UTC of the offset day is a safe anchor for reading the local calendar date
    const anchor = new Date(opts.from.getTime() + offset * 86_400_000);
    const local = zonedParts(anchor, opts.timeZone);
    for (const rule of applicable) {
      if (rule.dayOfWeek !== null && rule.dayOfWeek !== local.weekday) continue;
      const { hour, minute } = parseTimeOfDay(rule.timeOfDay);
      const at = zonedTimeToUtc(
        { year: local.year, month: local.month, day: local.day, hour, minute },
        opts.timeZone,
      );
      if (at.getTime() < earliest.getTime()) continue;
      if (opts.taken.some((t) => Math.abs(t.getTime() - at.getTime()) < spacing)) continue;
      candidates.push(at);
    }
    if (candidates.length) break;
  }
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0] ?? null;
}
