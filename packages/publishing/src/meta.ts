import { FatalError, ProviderError, sleep } from "@cre/shared";
import { socialRequest } from "./http.ts";
import { validateForPlatform } from "./limits.ts";
import type {
  AnalyticsContext,
  PlatformMetrics,
  PublicationStatus,
  PublisherHealth,
  PublishRequest,
  PublishResult,
  SocialCredentials,
  SocialPlatform,
  SocialPublisher,
} from "./types.ts";

/**
 * Meta Graph API publisher.
 *  Instagram Reels (Content Publishing API): create REELS container with video_url → poll status_code →
 *  media_publish → permalink. Requires an Instagram professional account linked to a Facebook Page and the
 *  instagram_content_publish permission (Meta app review).
 *  Facebook Page Reels: video_reels upload_phase=start → hosted file upload → finish (supports native scheduling).
 *
 * NOTE: implemented against Meta's documented flow; not exercised against the live API in this repository's
 * test suite (fetch is stubbed). Verify with a test Page/IG account before enabling PUBLISHING_ENABLED.
 */
export class MetaPublisher implements SocialPublisher {
  readonly name = "meta";
  readonly isMock = false;
  readonly platforms: readonly SocialPlatform[] = ["INSTAGRAM", "FACEBOOK"];
  private readonly base: string;

  constructor(
    private readonly opts: {
      graphVersion: string;
      appConfigured: boolean;
      pollIntervalMs?: number;
      maxPolls?: number;
    },
  ) {
    this.base = `https://graph.facebook.com/${opts.graphVersion}`;
  }

  healthCheck(): Promise<PublisherHealth> {
    return Promise.resolve({
      ok: this.opts.appConfigured,
      publisher: this.name,
      isMock: false,
      message: this.opts.appConfigured
        ? `Graph API ${this.opts.graphVersion}`
        : "META_APP_ID / META_APP_SECRET not configured",
    });
  }

  validate(req: PublishRequest): string[] {
    const problems = validateForPlatform(req, { needsPublicUrl: true });
    if (!req.account.externalAccountId)
      problems.push("social account has no Instagram user id / Facebook page id");
    if (!req.credentials) problems.push("no credentials — connect the account via OAuth");
    return problems;
  }

  private token(c: SocialCredentials | null, page = false): string {
    if (!c) throw new FatalError("Meta credentials missing");
    return page ? (c.pageAccessToken ?? c.accessToken) : c.accessToken;
  }

  async publish(req: PublishRequest, ctx: { signal?: AbortSignal }): Promise<PublishResult> {
    const problems = this.validate(req);
    if (problems.length) throw new FatalError(`Cannot publish to ${req.platform}: ${problems.join("; ")}`);
    return req.platform === "INSTAGRAM"
      ? this.publishInstagramReel(req, ctx.signal)
      : this.publishFacebookReel(req, ctx.signal);
  }

  private async publishInstagramReel(req: PublishRequest, signal?: AbortSignal): Promise<PublishResult> {
    const igUser = req.account.externalAccountId!;
    const token = this.token(req.credentials);
    const params = new URLSearchParams({
      media_type: "REELS",
      video_url: req.media.videoUrl!,
      caption: req.caption,
      share_to_feed: "true",
      access_token: token,
      ...(req.media.coverUrl ? { cover_url: req.media.coverUrl } : {}),
    });
    const container = await socialRequest<{ id: string }>("meta", `${this.base}/${igUser}/media`, {
      method: "POST",
      body: params,
      ...(signal ? { signal } : {}),
    });
    await this.waitForContainer(container.id, token, signal);
    const published = await socialRequest<{ id: string }>(
      "meta",
      `${this.base}/${igUser}/media_publish?${new URLSearchParams({ creation_id: container.id, access_token: token }).toString()}`,
      { method: "POST", ...(signal ? { signal } : {}) },
    );
    const permalink = await socialRequest<{ permalink?: string }>(
      "meta",
      `${this.base}/${published.id}?${new URLSearchParams({ fields: "permalink", access_token: token }).toString()}`,
      signal ? { signal } : {},
    ).catch(() => ({ permalink: undefined }));
    return {
      status: "PUBLISHED",
      externalPostId: published.id,
      containerId: container.id,
      ...(permalink.permalink ? { externalUrl: permalink.permalink } : {}),
    };
  }

  private async waitForContainer(containerId: string, token: string, signal?: AbortSignal): Promise<void> {
    const maxPolls = this.opts.maxPolls ?? 60;
    for (let i = 0; i < maxPolls; i++) {
      const s = await socialRequest<{ status_code?: string; status?: string }>(
        "meta",
        `${this.base}/${containerId}?${new URLSearchParams({ fields: "status_code,status", access_token: token }).toString()}`,
        signal ? { signal } : {},
      );
      if (s.status_code === "FINISHED" || s.status_code === "PUBLISHED") return;
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") {
        throw new ProviderError("meta", `container ${s.status_code}: ${s.status ?? ""}`, {
          retryable: false,
        });
      }
      await sleep(this.opts.pollIntervalMs ?? 5_000, signal);
    }
    throw new ProviderError("meta", "media container processing timed out", { retryable: true });
  }

  private async publishFacebookReel(
    req: PublishRequest,
    signal?: AbortSignal,
    scheduleAt?: Date,
  ): Promise<PublishResult> {
    const pageId = req.account.externalAccountId!;
    const token = this.token(req.credentials, true);
    const start = await socialRequest<{ video_id: string; upload_url: string }>(
      "meta",
      `${this.base}/${pageId}/video_reels?${new URLSearchParams({ upload_phase: "start", access_token: token }).toString()}`,
      { method: "POST", ...(signal ? { signal } : {}) },
    );
    await socialRequest("meta", start.upload_url, {
      method: "POST",
      headers: { Authorization: `OAuth ${token}`, file_url: req.media.videoUrl! },
      timeoutMs: 300_000,
      ...(signal ? { signal } : {}),
    });
    const description = req.link ? `${req.caption}\n\n${req.link}` : req.caption;
    const finishParams = new URLSearchParams({
      upload_phase: "finish",
      video_id: start.video_id,
      description,
      access_token: token,
      video_state: scheduleAt ? "SCHEDULED" : "PUBLISHED",
      ...(scheduleAt ? { scheduled_publish_time: String(Math.floor(scheduleAt.getTime() / 1000)) } : {}),
    });
    await socialRequest("meta", `${this.base}/${pageId}/video_reels?${finishParams.toString()}`, {
      method: "POST",
      ...(signal ? { signal } : {}),
    });
    return {
      status: "PROCESSING",
      externalPostId: start.video_id,
      containerId: start.video_id,
      externalUrl: `https://www.facebook.com/reel/${start.video_id}`,
    };
  }

  /** Facebook Pages support native scheduling (10 min – 30 days ahead). */
  async schedule(req: PublishRequest, at: Date, ctx: { signal?: AbortSignal }): Promise<PublishResult> {
    if (req.platform !== "FACEBOOK")
      throw new FatalError("Native scheduling is only supported for Facebook Pages");
    return this.publishFacebookReel(req, ctx.signal, at);
  }

  async getStatus(
    ref: { externalPostId?: string | null; containerId?: string | null },
    ctx: {
      credentials: SocialCredentials | null;
      signal?: AbortSignal;
      account: { platform: SocialPlatform };
    },
  ): Promise<PublicationStatus> {
    const id = ref.containerId ?? ref.externalPostId;
    if (!id) return { status: "FAILED", error: "no reference id" };
    if (ctx.account.platform === "INSTAGRAM") {
      const s = await socialRequest<{ status_code?: string }>(
        "meta",
        `${this.base}/${id}?${new URLSearchParams({ fields: "status_code", access_token: this.token(ctx.credentials) }).toString()}`,
        ctx.signal ? { signal: ctx.signal } : {},
      );
      return {
        status:
          s.status_code === "ERROR"
            ? "FAILED"
            : s.status_code === "PUBLISHED" || s.status_code === "FINISHED"
              ? "PUBLISHED"
              : "PROCESSING",
      };
    }
    const v = await socialRequest<{ status?: { video_status?: string } }>(
      "meta",
      `${this.base}/${id}?${new URLSearchParams({ fields: "status", access_token: this.token(ctx.credentials, true) }).toString()}`,
      ctx.signal ? { signal: ctx.signal } : {},
    );
    const vs = v.status?.video_status;
    return {
      status: vs === "error" ? "FAILED" : vs === "ready" || vs === "published" ? "PUBLISHED" : "PROCESSING",
    };
  }

  async getAnalytics(externalPostId: string, ctx: AnalyticsContext): Promise<PlatformMetrics> {
    if (ctx.account.platform === "INSTAGRAM") {
      const metrics = ["views", "reach", "likes", "comments", "shares", "saved", "ig_reels_avg_watch_time"];
      const res = await socialRequest<{
        data?: { name: string; values?: { value: number }[]; total_value?: { value: number } }[];
      }>(
        "meta",
        `${this.base}/${externalPostId}/insights?${new URLSearchParams({ metric: metrics.join(","), access_token: this.token(ctx.credentials) }).toString()}`,
        ctx.signal ? { signal: ctx.signal } : {},
      );
      const get = (name: string) => {
        const m = res.data?.find((d) => d.name === name);
        return m ? (m.total_value?.value ?? m.values?.[0]?.value ?? null) : null;
      };
      const views = get("views");
      return {
        capturedAt: ctx.now,
        impressions: views,
        reach: get("reach"),
        plays: views,
        views3s: null,
        completionRate: null,
        avgWatchTimeMs: get("ig_reels_avg_watch_time"),
        likes: get("likes"),
        comments: get("comments"),
        saves: get("saved"),
        shares: get("shares"),
        profileVisits: null,
        outboundClicks: null,
        follows: null,
        raw: { data: res.data ?? [] },
      };
    }
    const res = await socialRequest<{
      data?: { name: string; values?: { value: number | Record<string, number> }[] }[];
    }>(
      "meta",
      `${this.base}/${externalPostId}/video_insights?${new URLSearchParams({ access_token: this.token(ctx.credentials, true) }).toString()}`,
      ctx.signal ? { signal: ctx.signal } : {},
    );
    const num = (name: string) => {
      const v = res.data?.find((d) => d.name === name)?.values?.[0]?.value;
      return typeof v === "number" ? v : null;
    };
    const plays = num("blue_reels_play_count") ?? num("fb_reels_total_plays");
    return {
      capturedAt: ctx.now,
      impressions: num("post_impressions_unique") ?? plays,
      reach: num("post_impressions_unique"),
      plays,
      views3s: null,
      completionRate: null,
      avgWatchTimeMs: num("post_video_avg_time_watched"),
      likes: null,
      comments: null,
      saves: null,
      shares: null,
      profileVisits: null,
      outboundClicks: null,
      follows: num("post_video_followers"),
      raw: { data: res.data ?? [] },
    };
  }
}
