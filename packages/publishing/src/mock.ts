import { randomCode, seededRandom } from "@cre/shared";
import { validateForPlatform } from "./limits.ts";
import type {
  AnalyticsContext,
  PlatformMetrics,
  PublicationStatus,
  PublisherHealth,
  PublishRequest,
  PublishResult,
  SocialPlatform,
  SocialPublisher,
} from "./types.ts";

/**
 * Mock publisher (MOCK_SOCIAL=true): nothing leaves the machine. "Posts" get fake ids/URLs and analytics are
 * simulated deterministically: cumulative metrics grow along a saturating curve and depend on content quality
 * (QA score, hook style, duration) so the learning loop has a realistic signal to learn from.
 */
const BASE_IMPRESSIONS: Record<SocialPlatform, number> = { TIKTOK: 2400, INSTAGRAM: 1500, FACEBOOK: 700 };
const HOOK_FACTOR: Record<string, number> = {
  problem_solution: 1.25,
  mistake_warning: 1.2,
  comparison: 1.15,
  question: 1.0,
  number_list: 1.05,
  curiosity_gap: 1.1,
  deal_alert: 1.1,
  bold_claim: 0.95,
  pov: 0.85,
  how_to: 0.9,
  myth_busting: 1.0,
};

export class MockSocialPublisher implements SocialPublisher {
  readonly name = "mock";
  readonly isMock = true;
  readonly platforms: readonly SocialPlatform[] = ["INSTAGRAM", "FACEBOOK", "TIKTOK"];
  /** publications "posted" during this process (tests) */
  readonly posted: PublishRequest[] = [];

  constructor(private readonly opts: { failRate?: number } = {}) {}

  healthCheck(): Promise<PublisherHealth> {
    return Promise.resolve({
      ok: true,
      publisher: this.name,
      isMock: true,
      message: "mock publisher — nothing is posted publicly",
    });
  }

  validate(req: PublishRequest): string[] {
    return validateForPlatform(req, { needsPublicUrl: false });
  }

  publish(req: PublishRequest): Promise<PublishResult> {
    if (this.opts.failRate && seededRandom(req.idempotencyKey)() < this.opts.failRate) {
      return Promise.reject(new Error("mock platform rejected the post"));
    }
    this.posted.push(req);
    const id = `mock_${req.platform.toLowerCase()}_${randomCode(12)}`;
    return Promise.resolve({
      status: "PUBLISHED",
      externalPostId: id,
      externalUrl: `https://mock.social.test/${req.platform.toLowerCase()}/${req.account.handle.replace(/^@/, "")}/${id}`,
      raw: { mock: true },
    });
  }

  getStatus(ref: { externalPostId?: string | null }): Promise<PublicationStatus> {
    return Promise.resolve({
      status: "PUBLISHED",
      ...(ref.externalPostId ? { externalPostId: ref.externalPostId } : {}),
    });
  }

  getAnalytics(externalPostId: string, ctx: AnalyticsContext): Promise<PlatformMetrics> {
    return Promise.resolve(simulateMetrics(externalPostId, ctx));
  }
}

export function simulateMetrics(externalPostId: string, ctx: AnalyticsContext): PlatformMetrics {
  const rnd = seededRandom(ctx.hints?.seed ?? externalPostId);
  const platform = ctx.account.platform;
  const qa = Math.max(0, Math.min(100, ctx.hints?.qaScore ?? 75)) / 100;
  const hook = HOOK_FACTOR[ctx.hints?.hookStyle ?? ""] ?? 1;
  const durationSec = (ctx.hints?.durationMs ?? 25_000) / 1000;
  const quality = (0.55 + 0.8 * qa * qa) * hook;
  const finalImpressions = BASE_IMPRESSIONS[platform] * quality * (0.5 + rnd() * 1.3);
  const hours = Math.max(0, (ctx.now.getTime() - ctx.publishedAt.getTime()) / 3_600_000);
  const progress = 1 - Math.exp(-hours / 18);
  const impressions = Math.round(finalImpressions * progress);
  const plays = Math.round(impressions * (0.88 + rnd() * 0.08));
  const completionRate = Math.max(
    0.05,
    Math.min(0.85, 0.62 - 0.011 * durationSec + (rnd() - 0.5) * 0.12 + (hook - 1) * 0.2),
  );
  const likes = Math.round(plays * (0.02 + rnd() * 0.04) * quality);
  const profileVisits = Math.round(plays * (0.008 + rnd() * 0.012) * hook);
  const ctr = (0.004 + rnd() * 0.012) * quality;
  const outboundClicks =
    platform === "FACEBOOK"
      ? Math.round(impressions * ctr)
      : Math.round(profileVisits * (0.25 + rnd() * 0.15));
  return {
    capturedAt: ctx.now,
    impressions,
    reach: Math.round(impressions * (0.78 + rnd() * 0.12)),
    plays,
    views3s: Math.round(plays * (0.45 + rnd() * 0.25) * Math.min(1.3, hook)),
    completionRate: Math.round(completionRate * 1000) / 1000,
    avgWatchTimeMs: Math.round(durationSec * 1000 * (completionRate + (1 - completionRate) * 0.35)),
    likes,
    comments: Math.round(likes * (0.04 + rnd() * 0.05)),
    saves: Math.round(likes * (0.1 + rnd() * 0.12)),
    shares: Math.round(likes * (0.06 + rnd() * 0.08)),
    profileVisits,
    outboundClicks,
    follows: Math.round(profileVisits * 0.08),
    raw: { simulated: true, hours: Math.round(hours * 10) / 10 },
  };
}
