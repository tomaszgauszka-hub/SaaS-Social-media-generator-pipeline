import { describe, expect, it } from "vitest";
import { lines, list, money } from "./form";
import { createOAuthState, readOAuthState } from "./oauth";
import { rateLimit } from "./rate-limit";
import { cdnCountry, clientIp } from "./request";

describe("OAuth state (CSRF)", () => {
  it("round-trips a signed state bound to user, brand and provider", () => {
    const { state, cookie } = createOAuthState({ userId: "u1", brandId: "b1", provider: "meta" });
    expect(readOAuthState(cookie, state)).toMatchObject({ userId: "u1", brandId: "b1", provider: "meta" });
  });

  it("rejects a wrong state, a tampered payload and a missing cookie", () => {
    const { state, cookie } = createOAuthState({ userId: "u1", brandId: "b1", provider: "tiktok" });
    expect(readOAuthState(cookie, `${state}x`)).toBeNull();
    const [payload, sig] = cookie.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), userId: "attacker" }),
    ).toString("base64url");
    expect(readOAuthState(`${forged}.${sig}`, state)).toBeNull();
    expect(readOAuthState(undefined, state)).toBeNull();
  });
});

describe("rate limiter", () => {
  it("allows the limit, then blocks with a retry hint", () => {
    const key = `test:${Math.random()}`;
    for (let i = 0; i < 3; i++) expect(rateLimit(key, 3, 60_000).ok).toBe(true);
    const blocked = rateLimit(key, 3, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });
});

describe("request parsing", () => {
  it("takes the first forwarded address and a CDN country", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1", "cf-ipcountry": "PL" });
    expect(clientIp(h)).toBe("203.0.113.7");
    expect(cdnCountry(h)).toBe("PL");
    expect(clientIp(new Headers())).toBeNull();
  });
});

describe("form helpers", () => {
  it("parses lists, lines and optional money", () => {
    const f = new FormData();
    f.set("tags", "a, b,\nc");
    f.set("rules", "one\n\n two ");
    f.set("limit", "");
    f.set("cap", "2.50");
    expect(list(f, "tags")).toEqual(["a", "b", "c"]);
    expect(lines(f, "rules")).toEqual(["one", "two"]);
    expect(money(f, "limit")).toBeNull();
    expect(money(f, "cap")).toBe("2.50");
  });
});
