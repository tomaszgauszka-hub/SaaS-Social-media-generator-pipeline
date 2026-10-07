import { FatalError } from "@cre/shared";
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

const API = "https://open.tiktokapis.com/v2";

interface TikTokEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string; log_id?: string };
}

/**
 * TikTok Content Posting API (Direct Post).
 *   creator_info/query → video/init (PULL_FROM_URL) → status/fetch
 * Unaudited apps may only post with privacy SELF_ONLY (visible to the creator) — the default here, which is also
 * the safe choice for testing. Branded-content / AI-generated flags are set from the request.
 *
 * NOTE: implemented against TikTok's documented API; not exercised against the live API in this repository's
 * tests. Video URLs must be on a domain verified in the TikTok developer portal.
 */
export class TikTokPublisher implements SocialPublisher {
  readonly name = "tiktok";
  readonly isMock = false;
  readonly platforms: readonly SocialPlatform[] = ["TIKTOK"];

  constructor(private readonly opts: { appConfigured: boolean; privacyLevel?: string }) {}

  healthCheck(): Promise<PublisherHealth> {
    return Promise.resolve({
      ok: this.opts.appConfigured,
      publisher: this.name,
      isMock: false,
      message: this.opts.appConfigured
        ? `privacy ${this.opts.privacyLevel ?? "SELF_ONLY"}`
        : "TIKTOK_CLIENT_KEY / SECRET not configured",
    });
  }

  validate(req: PublishRequest): string[] {
    const problems = validateForPlatform(req, { needsPublicUrl: true });
    if (!req.media.videoUrl)
      problems.push("TikTok PULL_FROM_URL needs a public video URL on a verified domain");
    if (!req.credentials) problems.push("no credentials — connect the account via OAuth");
    return problems;
  }

  private headers(c: SocialCredentials | null): Record<string, string> {
    if (!c) throw new FatalError("TikTok credentials missing");
    return { Authorization: `Bearer ${c.accessToken}`, "Content-Type": "application/json; charset=UTF-8" };
  }

  async publish(req: PublishRequest, ctx: { signal?: AbortSignal }): Promise<PublishResult> {
    const problems = this.validate(req);
    if (problems.length) throw new FatalError(`Cannot publish to TikTok: ${problems.join("; ")}`);
    const headers = this.headers(req.credentials);
    const info = await socialRequest<
      TikTokEnvelope<{
        privacy_level_options?: string[];
        max_video_post_duration_sec?: number;
        comment_disabled?: boolean;
        duet_disabled?: boolean;
        stitch_disabled?: boolean;
      }>
    >("tiktok", `${API}/post/publish/creator_info/query/`, {
      method: "POST",
      headers,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const allowed = info.data?.privacy_level_options ?? ["SELF_ONLY"];
    const wanted = this.opts.privacyLevel ?? "SELF_ONLY";
    const privacy = allowed.includes(wanted) ? wanted : "SELF_ONLY";
    const maxSec = info.data?.max_video_post_duration_sec;
    if (maxSec && (req.media.durationMs ?? 0) / 1000 > maxSec)
      throw new FatalError(`Video longer than creator limit ${maxSec}s`);
    // Commercial-content disclosure. TikTok does not allow branded content to be private, and a private post has
    // no audience to disclose to — so the toggles apply to visible posts only.
    const visible = privacy !== "SELF_ONLY";

    const init = await socialRequest<TikTokEnvelope<{ publish_id: string }>>(
      "tiktok",
      `${API}/post/publish/video/init/`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          post_info: {
            title: req.caption.slice(0, 2200),
            privacy_level: privacy,
            // the creator's own interaction settings always win
            disable_comment: info.data?.comment_disabled ?? false,
            disable_duet: info.data?.duet_disabled ?? false,
            disable_stitch: info.data?.stitch_disabled ?? false,
            video_cover_timestamp_ms: 1200,
            brand_content_toggle: visible && req.promotion === "THIRD_PARTY",
            brand_organic_toggle: visible && req.promotion === "OWN_BUSINESS",
            is_aigc: req.aiGenerated,
          },
          source_info: { source: "PULL_FROM_URL", video_url: req.media.videoUrl },
        }),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
    );
    const publishId = init.data?.publish_id;
    if (!publishId) throw new FatalError(`TikTok init failed: ${init.error?.message ?? "no publish_id"}`);
    return { status: "PROCESSING", externalPostId: publishId, containerId: publishId };
  }

  async getStatus(
    ref: { externalPostId?: string | null; containerId?: string | null },
    ctx: { credentials: SocialCredentials | null; signal?: AbortSignal },
  ): Promise<PublicationStatus> {
    const publishId = ref.containerId ?? ref.externalPostId;
    if (!publishId) return { status: "FAILED", error: "no publish id" };
    const res = await socialRequest<
      TikTokEnvelope<{
        status?: string;
        fail_reason?: string;
        publicaly_available_post_id?: (string | number)[];
      }>
    >("tiktok", `${API}/post/publish/status/fetch/`, {
      method: "POST",
      headers: this.headers(ctx.credentials),
      body: JSON.stringify({ publish_id: publishId }),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const s = res.data?.status;
    if (s === "FAILED") return { status: "FAILED", error: res.data?.fail_reason ?? "failed" };
    if (s === "PUBLISH_COMPLETE") {
      const postId = res.data?.publicaly_available_post_id?.[0];
      return { status: "PUBLISHED", ...(postId ? { externalPostId: String(postId) } : {}) };
    }
    return { status: "PROCESSING" };
  }

  async getAnalytics(externalPostId: string, ctx: AnalyticsContext): Promise<PlatformMetrics> {
    const res = await socialRequest<
      TikTokEnvelope<{
        videos?: {
          id: string;
          view_count?: number;
          like_count?: number;
          comment_count?: number;
          share_count?: number;
        }[];
      }>
    >("tiktok", `${API}/video/query/?fields=id,view_count,like_count,comment_count,share_count`, {
      method: "POST",
      headers: this.headers(ctx.credentials),
      body: JSON.stringify({ filters: { video_ids: [externalPostId] } }),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const v = res.data?.videos?.[0];
    return {
      capturedAt: ctx.now,
      impressions: v?.view_count ?? null,
      reach: null,
      plays: v?.view_count ?? null,
      views3s: null,
      completionRate: null,
      avgWatchTimeMs: null,
      likes: v?.like_count ?? null,
      comments: v?.comment_count ?? null,
      saves: null,
      shares: v?.share_count ?? null,
      profileVisits: null,
      outboundClicks: null,
      follows: null,
      raw: { video: v ?? null },
    };
  }
}
