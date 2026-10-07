import { FatalError, ProviderError } from "@cre/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, stubFetch, text, type FetchStub } from "../../../test/fetch-stub.ts";
import { classifySocialError, parseJsonExact, redactUrl, socialRequest } from "./http.ts";
import { MetaPublisher } from "./meta.ts";
import {
  metaAuthorizeUrl,
  metaExchangeCode,
  tiktokAuthorizeUrl,
  tiktokExchangeCode,
  tiktokRefresh,
} from "./oauth.ts";
import { TikTokPublisher } from "./tiktok.ts";
import type { AnalyticsContext, PublishRequest, SocialAccountRef, SocialPlatform } from "./types.ts";

/**
 * Real publishers against scripted HTTP replies shaped like the documented Graph / TikTok responses.
 * These prove request construction, polling and error mapping — NOT that the live APIs accept the calls
 * (that needs a test account and app review; see docs/SOCIAL_APIS.md).
 */
const GRAPH = "https://graph.facebook.com/v23.0";
const TIKTOK = "https://open.tiktokapis.com/v2";

function account(
  platform: SocialPlatform,
  externalAccountId: string | null = "17841400000000001",
): SocialAccountRef {
  return { id: `acc-${platform}`, platform, handle: "@demo", externalAccountId, isMock: false };
}

function request(platform: SocialPlatform, over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    publicationId: "pub1",
    platform,
    account: account(platform, platform === "FACEBOOK" ? "1029384756" : "17841400000000001"),
    credentials: { accessToken: "USER_TOKEN", pageAccessToken: "PAGE_TOKEN" },
    media: {
      kind: "video",
      videoUrl: "https://cdn.example.com/v.mp4?X-Amz-Signature=abc",
      coverUrl: "https://cdn.example.com/c.jpg",
      durationMs: 21_000,
      width: 1080,
      height: 1920,
      sizeBytes: 6_000_000,
    },
    caption: "Three things nobody tells you about cordless drills\n\n#ad #tools",
    aiGenerated: true,
    idempotencyKey: "pub1:1",
    ...over,
  };
}

function analyticsCtx(platform: SocialPlatform): AnalyticsContext {
  return {
    account: account(platform),
    credentials: { accessToken: "USER_TOKEN", pageAccessToken: "PAGE_TOKEN" },
    publishedAt: new Date("2026-10-01T12:00:00Z"),
    now: new Date("2026-10-02T12:00:00Z"),
  };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

let http: FetchStub;
beforeEach(() => {
  http = stubFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ error classification ------ */

describe("social API error classification", () => {
  it("maps expired tokens and missing permissions to non-retryable errors", () => {
    expect(
      classifySocialError(400, {
        error: {
          message: "Error validating access token: Session has expired",
          type: "OAuthException",
          code: 190,
        },
      }),
    ).toMatchObject({ code: "AUTH_EXPIRED", retryable: false });
    expect(
      classifySocialError(401, { error: { code: "access_token_invalid", message: "invalid" } }),
    ).toMatchObject({
      code: "AUTH_EXPIRED",
      retryable: false,
    });
    expect(
      classifySocialError(403, { error: { message: "(#10) Permission denied", code: 10 } }),
    ).toMatchObject({
      code: "PERMISSION_DENIED",
      retryable: false,
    });
    expect(
      classifySocialError(403, { error: { message: "(#200) Requires permission", code: 200 } }).code,
    ).toBe("PERMISSION_DENIED");
  });

  it("retries Meta throttling even though it arrives as HTTP 400", () => {
    expect(
      classifySocialError(400, { error: { message: "(#4) Application request limit reached", code: 4 } }),
    ).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(
      classifySocialError(400, { error: { message: "(#32) Page request limit", code: 32 } }).retryable,
    ).toBe(true);
    expect(
      classifySocialError(429, { error: { code: "rate_limit_exceeded", message: "slow down" } }),
    ).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
    expect(
      classifySocialError(400, { error: { message: "blip", code: 2, is_transient: true } }).retryable,
    ).toBe(true);
  });

  it("leaves other errors to the HTTP status and never pattern-matches numbers inside messages", () => {
    const invalid = classifySocialError(400, {
      error: { message: "(#100) Video duration 1900 ms is too short", code: 100 },
    });
    expect(invalid).toEqual({
      message: "(#100) Video duration 1900 ms is too short (100)",
      code: "PROVIDER_ERROR",
    });
    expect(classifySocialError(502, { raw: "<html>bad gateway</html>" }).message).toBe("HTTP 502");
  });

  it("socialRequest turns responses into ProviderErrors with the right retryability", async () => {
    http
      .on(
        "GET",
        "https://api.example.com/expired",
        json({ error: { message: "Session has expired", code: 190 } }, 400),
      )
      .on(
        "GET",
        "https://api.example.com/throttled",
        json({ error: { message: "(#4) limit", code: 4 } }, 400),
      )
      .on(
        "GET",
        "https://api.example.com/invalid",
        json({ error: { message: "(#100) bad param", code: 100 } }, 400),
      )
      .on("GET", "https://api.example.com/down", text("<html>oops</html>", 503))
      .on("GET", "https://api.example.com/ok", json({ id: "1" }));

    const expired = await rejection(
      socialRequest("meta", "https://api.example.com/expired?access_token=SECRET"),
    );
    expect(expired).toBeInstanceOf(ProviderError);
    expect(expired).toMatchObject({ code: "AUTH_EXPIRED", retryable: false, status: 400 });
    expect(String(expired)).not.toContain("SECRET");
    expect(await rejection(socialRequest("meta", "https://api.example.com/throttled"))).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
    expect(await rejection(socialRequest("meta", "https://api.example.com/invalid"))).toMatchObject({
      code: "PROVIDER_ERROR",
      retryable: false,
    });
    expect(await rejection(socialRequest("meta", "https://api.example.com/down"))).toMatchObject({
      status: 503,
      retryable: true,
    });
    await expect(socialRequest("meta", "https://api.example.com/ok")).resolves.toEqual({ id: "1" });
  });

  it("treats network failures as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    expect(await rejection(socialRequest("tiktok", "https://open.tiktokapis.com/v2/x"))).toMatchObject({
      retryable: true,
      provider: "tiktok",
    });
  });

  it("keeps int64 ids exact while parsing ordinary numbers normally", () => {
    expect(
      parseJsonExact(
        '{"ids":[7311111111111111111,-9007199254740993],"n":12,"f":1.5,"s":"7311111111111111111"}',
      ),
    ).toEqual({
      ids: ["7311111111111111111", "-9007199254740993"],
      n: 12,
      f: 1.5,
      s: "7311111111111111111",
    });
  });

  it("redacts tokens from URLs", () => {
    expect(redactUrl("https://x/y?access_token=abc&fields=id&client_secret=s&code=c")).toBe(
      "https://x/y?access_token=[redacted]&fields=id&client_secret=[redacted]&code=[redacted]",
    );
  });
});

/* ------------------------------------------------------------------ Meta ------------------------- */

describe("MetaPublisher — Instagram Reels", () => {
  const meta = () =>
    new MetaPublisher({ graphVersion: "v23.0", appConfigured: true, pollIntervalMs: 0, maxPolls: 3 });
  const igUser = "17841400000000001";

  it("creates a REELS container, waits for processing, publishes and fetches the permalink", async () => {
    http
      .on("POST", `${GRAPH}/${igUser}/media`, json({ id: "c1" }))
      .on("GET", `${GRAPH}/c1`, json({ status_code: "IN_PROGRESS" }), json({ status_code: "FINISHED" }))
      .on("POST", `${GRAPH}/${igUser}/media_publish`, json({ id: "m1" }))
      .on("GET", `${GRAPH}/m1`, json({ permalink: "https://www.instagram.com/reel/abc/" }));

    const result = await meta().publish(request("INSTAGRAM"), {});
    expect(result).toEqual({
      status: "PUBLISHED",
      externalPostId: "m1",
      containerId: "c1",
      externalUrl: "https://www.instagram.com/reel/abc/",
    });
    expect(http.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /v23.0/17841400000000001/media",
      "GET /v23.0/c1",
      "GET /v23.0/c1",
      "POST /v23.0/17841400000000001/media_publish",
      "GET /v23.0/m1",
    ]);
    const container = new URLSearchParams(http.calls[0]!.body ?? "");
    expect(Object.fromEntries(container)).toMatchObject({
      media_type: "REELS",
      video_url: "https://cdn.example.com/v.mp4?X-Amz-Signature=abc",
      cover_url: "https://cdn.example.com/c.jpg",
      share_to_feed: "true",
      access_token: "USER_TOKEN",
    });
    expect(container.get("caption")).toContain("#ad");
    expect(http.calls[3]!.url.searchParams.get("creation_id")).toBe("c1");
  });

  it("publishes even when the permalink lookup fails", async () => {
    http
      .on("POST", `${GRAPH}/${igUser}/media`, json({ id: "c1" }))
      .on("GET", `${GRAPH}/c1`, json({ status_code: "FINISHED" }))
      .on("POST", `${GRAPH}/${igUser}/media_publish`, json({ id: "m1" }))
      .on("GET", `${GRAPH}/m1`, json({ error: { message: "temporarily unavailable", code: 2 } }, 500));
    const result = await meta().publish(request("INSTAGRAM"), {});
    expect(result.status).toBe("PUBLISHED");
    expect(result.externalUrl).toBeUndefined();
  });

  it("fails permanently when the container errors and retryably when processing never finishes", async () => {
    http
      .on("POST", `${GRAPH}/${igUser}/media`, json({ id: "c-err" }))
      .on("GET", `${GRAPH}/c-err`, json({ status_code: "ERROR", status: "Error: unsupported codec" }));
    const failed = await rejection(meta().publish(request("INSTAGRAM"), {}));
    expect(failed).toBeInstanceOf(ProviderError);
    expect(failed).toMatchObject({ retryable: false });
    expect(String(failed)).toContain("unsupported codec");
    expect(http.callsTo(`${GRAPH}/${igUser}/media_publish`)).toHaveLength(0);

    const slow = stubFetch()
      .on("POST", `${GRAPH}/${igUser}/media`, json({ id: "c-slow" }))
      .on("GET", `${GRAPH}/c-slow`, json({ status_code: "IN_PROGRESS" }));
    const timedOut = await rejection(meta().publish(request("INSTAGRAM"), {}));
    expect(timedOut).toMatchObject({ retryable: true });
    expect(slow.callsTo(`${GRAPH}/c-slow`)).toHaveLength(3); // maxPolls
  });

  it("maps an expired token on container creation to AUTH_EXPIRED without leaking it", async () => {
    http.on(
      "POST",
      `${GRAPH}/${igUser}/media`,
      json(
        {
          error: {
            message: "Error validating access token: Session has expired on Tuesday",
            type: "OAuthException",
            code: 190,
            error_subcode: 463,
          },
        },
        400,
      ),
    );
    const err = await rejection(meta().publish(request("INSTAGRAM"), {}));
    expect(err).toMatchObject({ code: "AUTH_EXPIRED", retryable: false });
    expect(JSON.stringify(err)).not.toContain("USER_TOKEN");
    expect(String(err)).not.toContain("USER_TOKEN");
  });

  it("refuses invalid posts before any HTTP call", async () => {
    const bad = request("INSTAGRAM", {
      credentials: null,
      account: account("INSTAGRAM", null),
      media: { kind: "video", durationMs: 1_000 },
    });
    expect(meta().validate(bad)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("duration"),
        expect.stringContaining("public video URL"),
        expect.stringContaining("Instagram user id"),
        expect.stringContaining("no credentials"),
      ]),
    );
    await expect(meta().publish(bad, {})).rejects.toBeInstanceOf(FatalError);
    expect(http.calls).toHaveLength(0);
  });

  it("maps container status codes", async () => {
    http.on(
      "GET",
      `${GRAPH}/c1`,
      json({ status_code: "IN_PROGRESS" }),
      json({ status_code: "PUBLISHED" }),
      json({ status_code: "ERROR" }),
    );
    const ctx = { account: account("INSTAGRAM"), credentials: { accessToken: "USER_TOKEN" } };
    await expect(meta().getStatus({ containerId: "c1" }, ctx)).resolves.toEqual({ status: "PROCESSING" });
    await expect(meta().getStatus({ containerId: "c1" }, ctx)).resolves.toEqual({ status: "PUBLISHED" });
    await expect(meta().getStatus({ containerId: "c1" }, ctx)).resolves.toEqual({ status: "FAILED" });
    await expect(meta().getStatus({}, ctx)).resolves.toMatchObject({ status: "FAILED" });
    expect(http.calls).toHaveLength(3);
  });

  it("reads Reels insights (total_value and values shapes)", async () => {
    http.on(
      "GET",
      `${GRAPH}/m1/insights`,
      json({
        data: [
          { name: "views", total_value: { value: 1200 } },
          { name: "reach", values: [{ value: 900 }] },
          { name: "likes", total_value: { value: 40 } },
          { name: "comments", total_value: { value: 3 } },
          { name: "shares", total_value: { value: 5 } },
          { name: "saved", total_value: { value: 7 } },
          { name: "ig_reels_avg_watch_time", total_value: { value: 5400 } },
        ],
      }),
    );
    const m = await meta().getAnalytics("m1", analyticsCtx("INSTAGRAM"));
    expect(m).toMatchObject({
      impressions: 1200,
      plays: 1200,
      reach: 900,
      likes: 40,
      comments: 3,
      shares: 5,
      saves: 7,
      avgWatchTimeMs: 5400,
      outboundClicks: null,
    });
    expect(http.calls[0]!.url.searchParams.get("metric")?.split(",")).toContain("views");
    expect(http.calls[0]!.url.searchParams.get("access_token")).toBe("USER_TOKEN");
  });
});

describe("MetaPublisher — Facebook Page Reels", () => {
  const meta = () => new MetaPublisher({ graphVersion: "v23.0", appConfigured: true, pollIntervalMs: 0 });
  const page = "1029384756";
  const uploadUrl = "https://rupload.facebook.com/video-upload/v23.0/v1";

  function scriptReelUpload() {
    http
      .on("POST", `${GRAPH}/${page}/video_reels`, (req) =>
        req.url.searchParams.get("upload_phase") === "start"
          ? json({ video_id: "v1", upload_url: uploadUrl })
          : json({ success: true }),
      )
      .on("POST", uploadUrl, json({ success: true }));
  }

  it("uploads by hosted URL with the page token and finishes as PUBLISHED", async () => {
    scriptReelUpload();
    const result = await meta().publish(
      request("FACEBOOK", { link: "https://app.example.com/go/abc1234" }),
      {},
    );
    expect(result).toEqual({
      status: "PROCESSING",
      externalPostId: "v1",
      containerId: "v1",
      externalUrl: "https://www.facebook.com/reel/v1",
    });
    const [start, upload, finish] = http.calls;
    expect(start!.url.searchParams.get("access_token")).toBe("PAGE_TOKEN");
    expect(upload!.url.href).toBe(uploadUrl);
    expect(upload!.headers.get("authorization")).toBe("OAuth PAGE_TOKEN");
    expect(upload!.headers.get("file_url")).toBe("https://cdn.example.com/v.mp4?X-Amz-Signature=abc");
    expect(finish!.url.searchParams.get("upload_phase")).toBe("finish");
    expect(finish!.url.searchParams.get("video_state")).toBe("PUBLISHED");
    expect(finish!.url.searchParams.get("description")).toContain("https://app.example.com/go/abc1234");
  });

  it("uses native scheduling for Facebook only", async () => {
    scriptReelUpload();
    const at = new Date("2026-10-08T18:00:00Z");
    await meta().schedule(request("FACEBOOK"), at, {});
    const finish = http.calls.at(-1)!;
    expect(finish.url.searchParams.get("video_state")).toBe("SCHEDULED");
    expect(finish.url.searchParams.get("scheduled_publish_time")).toBe(String(at.getTime() / 1000));
    await expect(meta().schedule(request("INSTAGRAM"), at, {})).rejects.toBeInstanceOf(FatalError);
  });

  it("maps video status and reads video insights", async () => {
    http
      .on(
        "GET",
        `${GRAPH}/v1`,
        json({ status: { video_status: "processing" } }),
        json({ status: { video_status: "ready" } }),
        json({ status: { video_status: "error" } }),
      )
      .on(
        "GET",
        `${GRAPH}/v1/video_insights`,
        json({
          data: [
            { name: "blue_reels_play_count", values: [{ value: 500 }] },
            { name: "post_impressions_unique", values: [{ value: 450 }] },
            { name: "post_video_avg_time_watched", values: [{ value: 4000 }] },
            { name: "post_video_followers", values: [{ value: 2 }] },
            { name: "post_video_social_actions", values: [{ value: { share: 3 } }] },
          ],
        }),
      );
    const ctx = {
      account: account("FACEBOOK"),
      credentials: { accessToken: "USER_TOKEN", pageAccessToken: "PAGE_TOKEN" },
    };
    await expect(meta().getStatus({ externalPostId: "v1" }, ctx)).resolves.toEqual({ status: "PROCESSING" });
    await expect(meta().getStatus({ externalPostId: "v1" }, ctx)).resolves.toEqual({ status: "PUBLISHED" });
    await expect(meta().getStatus({ externalPostId: "v1" }, ctx)).resolves.toEqual({ status: "FAILED" });
    expect(http.calls[0]!.url.searchParams.get("access_token")).toBe("PAGE_TOKEN");

    const m = await meta().getAnalytics("v1", analyticsCtx("FACEBOOK"));
    expect(m).toMatchObject({
      plays: 500,
      impressions: 450,
      reach: 450,
      avgWatchTimeMs: 4000,
      follows: 2,
      likes: null,
    });
  });
});

/* ------------------------------------------------------------------ TikTok ----------------------- */

describe("TikTokPublisher", () => {
  const creatorInfo = (options: string[], maxSec = 600) =>
    json({
      data: { privacy_level_options: options, max_video_post_duration_sec: maxSec },
      error: { code: "ok" },
    });

  it("queries the creator, then initialises a PULL_FROM_URL direct post labelled as AI-generated", async () => {
    http
      .on(
        "POST",
        `${TIKTOK}/post/publish/creator_info/query/`,
        creatorInfo(["PUBLIC_TO_EVERYONE", "SELF_ONLY"]),
      )
      .on(
        "POST",
        `${TIKTOK}/post/publish/video/init/`,
        json({ data: { publish_id: "v_pub_123" }, error: { code: "ok" } }),
      );
    const result = await new TikTokPublisher({ appConfigured: true }).publish(request("TIKTOK"), {});
    expect(result).toEqual({ status: "PROCESSING", externalPostId: "v_pub_123", containerId: "v_pub_123" });

    const init = http.callsTo(`${TIKTOK}/post/publish/video/init/`)[0]!;
    expect(init.headers.get("authorization")).toBe("Bearer USER_TOKEN");
    const body = JSON.parse(init.body ?? "{}") as {
      post_info: Record<string, unknown>;
      source_info: Record<string, unknown>;
    };
    expect(body.post_info).toMatchObject({
      privacy_level: "SELF_ONLY",
      is_aigc: true,
      brand_content_toggle: false,
    });
    expect(body.post_info.title).toContain("cordless drills");
    expect(body.source_info).toEqual({
      source: "PULL_FROM_URL",
      video_url: "https://cdn.example.com/v.mp4?X-Amz-Signature=abc",
    });
  });

  it("uses a configured privacy level only when the creator allows it", async () => {
    http
      .on(
        "POST",
        `${TIKTOK}/post/publish/creator_info/query/`,
        creatorInfo(["PUBLIC_TO_EVERYONE", "SELF_ONLY"]),
        creatorInfo(["SELF_ONLY"]),
      )
      .on("POST", `${TIKTOK}/post/publish/video/init/`, json({ data: { publish_id: "p" } }));
    const publisher = new TikTokPublisher({ appConfigured: true, privacyLevel: "PUBLIC_TO_EVERYONE" });
    await publisher.publish(request("TIKTOK"), {});
    await publisher.publish(request("TIKTOK"), {});
    const privacy = http
      .callsTo(`${TIKTOK}/post/publish/video/init/`)
      .map(
        (c) =>
          (JSON.parse(c.body ?? "{}") as { post_info: { privacy_level: string } }).post_info.privacy_level,
      );
    expect(privacy).toEqual(["PUBLIC_TO_EVERYONE", "SELF_ONLY"]);
  });

  it("discloses commercial content on visible posts and respects the creator's interaction settings", async () => {
    http
      .on(
        "POST",
        `${TIKTOK}/post/publish/creator_info/query/`,
        json({
          data: {
            privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
            max_video_post_duration_sec: 600,
            comment_disabled: false,
            duet_disabled: true,
            stitch_disabled: true,
          },
        }),
      )
      .on("POST", `${TIKTOK}/post/publish/video/init/`, json({ data: { publish_id: "p" } }));
    const visible = new TikTokPublisher({ appConfigured: true, privacyLevel: "PUBLIC_TO_EVERYONE" });
    const hidden = new TikTokPublisher({ appConfigured: true });
    await visible.publish(request("TIKTOK", { promotion: "THIRD_PARTY" }), {});
    await visible.publish(request("TIKTOK", { promotion: "OWN_BUSINESS" }), {});
    await hidden.publish(request("TIKTOK", { promotion: "THIRD_PARTY" }), {});
    const infos = http
      .callsTo(`${TIKTOK}/post/publish/video/init/`)
      .map((c) => (JSON.parse(c.body ?? "{}") as { post_info: Record<string, unknown> }).post_info);
    expect(infos.map((i) => [i.privacy_level, i.brand_content_toggle, i.brand_organic_toggle])).toEqual([
      ["PUBLIC_TO_EVERYONE", true, false], // affiliate → branded content
      ["PUBLIC_TO_EVERYONE", false, true], // own product → "your brand"
      ["SELF_ONLY", false, false], // TikTok forbids private branded content; nobody else sees it anyway
    ]);
    expect(
      infos.every((i) => i.disable_duet === true && i.disable_stitch === true && i.disable_comment === false),
    ).toBe(true);
  });

  it("rejects videos longer than the creator's limit before initialising an upload", async () => {
    http.on("POST", `${TIKTOK}/post/publish/creator_info/query/`, creatorInfo(["SELF_ONLY"], 15));
    await expect(new TikTokPublisher({ appConfigured: true }).publish(request("TIKTOK"), {})).rejects.toThrow(
      /longer than creator limit 15s/,
    );
    expect(http.callsTo(`${TIKTOK}/post/publish/video/init/`)).toHaveLength(0);
  });

  it("fails clearly when init returns no publish id and maps auth errors", async () => {
    http
      .on(
        "POST",
        `${TIKTOK}/post/publish/creator_info/query/`,
        creatorInfo(["SELF_ONLY"]),
        json({ error: { code: "access_token_invalid", message: "The access token is invalid" } }, 401),
      )
      .on(
        "POST",
        `${TIKTOK}/post/publish/video/init/`,
        json({ data: {}, error: { code: "invalid_param", message: "bad video_url" } }),
      );
    const publisher = new TikTokPublisher({ appConfigured: true });
    await expect(publisher.publish(request("TIKTOK"), {})).rejects.toThrow(/bad video_url/);
    expect(await rejection(publisher.publish(request("TIKTOK"), {}))).toMatchObject({
      code: "AUTH_EXPIRED",
      retryable: false,
    });
  });

  it("maps publish status and reads video metrics", async () => {
    http
      .on(
        "POST",
        `${TIKTOK}/post/publish/status/fetch/`,
        json({ data: { status: "PROCESSING_DOWNLOAD" } }),
        // raw text: the int64 post id must survive parsing exactly (a JS number literal would already be rounded)
        text(
          '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7311111111111111111]}}',
          200,
          {
            "content-type": "application/json",
          },
        ),
        json({ data: { status: "FAILED", fail_reason: "file_format_check_failed" } }),
      )
      .on(
        "POST",
        `${TIKTOK}/video/query/`,
        json({
          data: {
            videos: [{ id: "731", view_count: 2500, like_count: 90, comment_count: 4, share_count: 12 }],
          },
        }),
      );
    const publisher = new TikTokPublisher({ appConfigured: true });
    const ctx = { account: account("TIKTOK"), credentials: { accessToken: "USER_TOKEN" } };
    await expect(publisher.getStatus({ containerId: "v_pub_123" }, ctx)).resolves.toEqual({
      status: "PROCESSING",
    });
    await expect(publisher.getStatus({ containerId: "v_pub_123" }, ctx)).resolves.toEqual({
      status: "PUBLISHED",
      externalPostId: "7311111111111111111",
    });
    await expect(publisher.getStatus({ containerId: "v_pub_123" }, ctx)).resolves.toEqual({
      status: "FAILED",
      error: "file_format_check_failed",
    });
    expect(JSON.parse(http.calls[0]!.body ?? "{}")).toEqual({ publish_id: "v_pub_123" });

    const m = await publisher.getAnalytics("731", analyticsCtx("TIKTOK"));
    expect(m).toMatchObject({
      impressions: 2500,
      plays: 2500,
      likes: 90,
      comments: 4,
      shares: 12,
      reach: null,
    });
    const query = http.callsTo(`${TIKTOK}/video/query/`)[0]!;
    expect(query.url.searchParams.get("fields")).toContain("view_count");
    expect(JSON.parse(query.body ?? "{}")).toEqual({ filters: { video_ids: ["731"] } });
  });
});

/* ------------------------------------------------------------------ OAuth ------------------------ */

describe("OAuth helpers", () => {
  it("builds authorize URLs with state and scopes", () => {
    const meta = new URL(
      metaAuthorizeUrl({
        appId: "app1",
        redirectUri: "https://app.example.com/cb",
        state: "s1",
        graphVersion: "v23.0",
      }),
    );
    expect(meta.origin + meta.pathname).toBe("https://www.facebook.com/v23.0/dialog/oauth");
    expect(meta.searchParams.get("state")).toBe("s1");
    expect(meta.searchParams.get("scope")).toContain("instagram_content_publish");
    const tt = new URL(
      tiktokAuthorizeUrl({ clientKey: "ck", redirectUri: "https://app.example.com/cb", state: "s2" }),
    );
    expect(tt.searchParams.get("client_key")).toBe("ck");
    expect(tt.searchParams.get("scope")).toContain("video.publish");
    expect(tt.searchParams.get("state")).toBe("s2");
  });

  it("exchanges a Meta code for a long-lived token and lists pages with linked IG accounts", async () => {
    http
      .on("GET", `${GRAPH}/oauth/access_token`, (req) =>
        req.url.searchParams.get("grant_type") === "fb_exchange_token"
          ? json({ access_token: "LONG", expires_in: 5_184_000 })
          : json({ access_token: "SHORT" }),
      )
      .on(
        "GET",
        `${GRAPH}/me/accounts`,
        json({
          data: [
            {
              id: "p1",
              name: "Demo Tools",
              access_token: "PAGE1",
              instagram_business_account: { id: "ig1", username: "demotools" },
            },
            { id: "p2", name: "No IG", access_token: "PAGE2" },
          ],
        }),
      );
    const before = Date.now();
    const res = await metaExchangeCode({
      appId: "app1",
      appSecret: "secret",
      redirectUri: "https://app.example.com/cb",
      code: "CODE",
      graphVersion: "v23.0",
    });
    expect(res.userAccessToken).toBe("LONG");
    expect(res.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 5_184_000_000);
    expect(res.pages).toEqual([
      {
        pageId: "p1",
        pageName: "Demo Tools",
        pageAccessToken: "PAGE1",
        instagramUserId: "ig1",
        instagramUsername: "demotools",
      },
      {
        pageId: "p2",
        pageName: "No IG",
        pageAccessToken: "PAGE2",
        instagramUserId: null,
        instagramUsername: null,
      },
    ]);
    expect(http.calls[1]!.url.searchParams.get("fb_exchange_token")).toBe("SHORT");
    expect(http.calls[2]!.url.searchParams.get("access_token")).toBe("LONG");
  });

  it("exchanges and refreshes TikTok tokens with form-encoded requests", async () => {
    http.on(
      "POST",
      "https://open.tiktokapis.com/v2/oauth/token/",
      json({
        access_token: "AT",
        refresh_token: "RT",
        open_id: "open1",
        expires_in: 86_400,
        refresh_expires_in: 31_536_000,
        scope: "video.publish,video.list",
      }),
    );
    const tokens = await tiktokExchangeCode({
      clientKey: "ck",
      clientSecret: "cs",
      code: "CODE",
      redirectUri: "https://app.example.com/cb",
    });
    expect(tokens).toMatchObject({
      accessToken: "AT",
      refreshToken: "RT",
      openId: "open1",
      scope: "video.publish,video.list",
    });
    await tiktokRefresh({ clientKey: "ck", clientSecret: "cs", refreshToken: "RT" });
    const [exchange, refresh] = http.calls.map((c) => new URLSearchParams(c.body ?? ""));
    expect(exchange!.get("grant_type")).toBe("authorization_code");
    expect(exchange!.get("code")).toBe("CODE");
    expect(refresh!.get("grant_type")).toBe("refresh_token");
    expect(refresh!.get("refresh_token")).toBe("RT");
    expect(http.calls[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  });
});
