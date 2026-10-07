import { describe, expect, it } from "vitest";
import { nextSlot } from "../scheduling/slots.ts";
import {
  buildRedirectUrl,
  parseUserAgent,
  publicLinkUrl,
  referrerHost,
  trackingUrl,
  visitorHash,
} from "./links.ts";

const IPHONE_IG =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0";
const ANDROID_TT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36 musical_ly_2023";
const DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const FB_PREVIEW = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

describe("redirect URLs", () => {
  const link = {
    destinationUrl: "https://example.com/aff/drill?tag=demotools-20",
    subIdParam: "ascsubtag",
    appendUtm: false,
    utmSource: "tiktok",
    utmMedium: "social",
    utmCampaign: "drill",
    utmContent: null,
    utmTerm: null,
  };

  it("passes our click id as the network sub-id and keeps existing params", () => {
    const url = new URL(buildRedirectUrl(link, "CLICK123"));
    expect(url.searchParams.get("ascsubtag")).toBe("CLICK123");
    expect(url.searchParams.get("tag")).toBe("demotools-20");
    expect(url.searchParams.has("utm_source")).toBe(false); // affiliate URLs stay untouched
  });

  it("appends UTMs only when enabled (own sites)", () => {
    const url = new URL(buildRedirectUrl({ ...link, appendUtm: true }, "C"));
    expect(url.searchParams.get("utm_source")).toBe("tiktok");
    expect(url.searchParams.get("utm_campaign")).toBe("drill");
  });

  it("uses the raw affiliate URL for programs that forbid redirects", () => {
    expect(
      publicLinkUrl("https://app.test", {
        code: "Ab12Cd3",
        redirect: true,
        destinationUrl: "https://x.test/p",
        subIdParam: null,
      }),
    ).toBe("https://app.test/go/Ab12Cd3");
    expect(
      publicLinkUrl("https://app.test", {
        code: "Ab12Cd3",
        redirect: false,
        destinationUrl: "https://x.test/p?a=1",
        subIdParam: "sid",
      }),
    ).toBe("https://x.test/p?a=1&sid=Ab12Cd3");
    expect(trackingUrl("https://app.test/", "X")).toBe("https://app.test/go/X");
  });
});

describe("privacy-minimised request parsing", () => {
  it("classifies devices, OS and in-app browsers", () => {
    expect(parseUserAgent(IPHONE_IG)).toEqual({
      deviceType: "mobile",
      osFamily: "iOS",
      browserFamily: "Instagram in-app",
      isBot: false,
    });
    expect(parseUserAgent(ANDROID_TT)).toMatchObject({
      deviceType: "mobile",
      osFamily: "Android",
      browserFamily: "TikTok in-app",
    });
    expect(parseUserAgent(DESKTOP)).toMatchObject({
      deviceType: "desktop",
      osFamily: "Windows",
      browserFamily: "Chrome",
    });
    expect(parseUserAgent(FB_PREVIEW)).toMatchObject({ deviceType: "bot", isBot: true });
    expect(parseUserAgent(null).deviceType).toBe("unknown");
  });

  it("hashes visitors with a daily rotating salt and never returns the IP", () => {
    const d1 = new Date("2026-10-07T10:00:00Z");
    const d2 = new Date("2026-10-08T10:00:00Z");
    const a = visitorHash("secret", "203.0.113.7", DESKTOP, d1)!;
    expect(a).toHaveLength(32);
    expect(a).not.toContain("203");
    expect(visitorHash("secret", "203.0.113.7", DESKTOP, d1)).toBe(a);
    expect(visitorHash("secret", "203.0.113.7", DESKTOP, d2)).not.toBe(a);
    expect(visitorHash("secret", null, DESKTOP, d1)).toBeNull();
  });

  it("keeps only the referrer host", () => {
    expect(referrerHost("https://l.instagram.com/?u=https%3A%2F%2Fx&e=secret")).toBe("l.instagram.com");
    expect(referrerHost("garbage")).toBeNull();
  });
});

describe("slot scheduling", () => {
  const rules = [
    { platform: "TIKTOK", dayOfWeek: null, timeOfDay: "12:00" },
    { platform: "INSTAGRAM", dayOfWeek: null, timeOfDay: "15:00" },
    { platform: "FACEBOOK", dayOfWeek: 3, timeOfDay: "18:00" }, // Wednesdays only
  ];
  const base = { timeZone: "America/Chicago", minLeadMinutes: 10, horizonDays: 14, taken: [] as Date[] };

  it("picks the next local slot after the lead time", () => {
    // 2026-10-07 09:00 Chicago (CDT, UTC-5) → TikTok 12:00 local same day = 17:00Z
    const from = new Date("2026-10-07T14:00:00Z");
    expect(nextSlot(rules, { ...base, platform: "TIKTOK", from })!.toISOString()).toBe(
      "2026-10-07T17:00:00.000Z",
    );
  });

  it("rolls over to the next day when today's slot passed or is taken", () => {
    const from = new Date("2026-10-07T17:30:00Z");
    expect(nextSlot(rules, { ...base, platform: "TIKTOK", from })!.toISOString()).toBe(
      "2026-10-08T17:00:00.000Z",
    );
    const taken = [new Date("2026-10-08T17:00:00Z")];
    expect(nextSlot(rules, { ...base, platform: "TIKTOK", from, taken })!.toISOString()).toBe(
      "2026-10-09T17:00:00.000Z",
    );
  });

  it("honours day-of-week rules", () => {
    const from = new Date("2026-10-08T00:00:00Z"); // Wednesday evening Chicago is past → next Wednesday
    expect(nextSlot(rules, { ...base, platform: "FACEBOOK", from })!.toISOString()).toBe(
      "2026-10-14T23:00:00.000Z",
    );
  });

  it("returns null without rules for the platform", () => {
    expect(nextSlot(rules, { ...base, platform: "YOUTUBE", from: new Date() })).toBeNull();
  });
});
