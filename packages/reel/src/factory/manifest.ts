import type { ShotClip } from "../contracts/media.ts";
import type { FallbackRecord, QaReport } from "../contracts/manifest.ts";
import { ReelManifest } from "../contracts/manifest.ts";
import type { QualityTier } from "../contracts/ids.ts";
import type { ReelPlan } from "../contracts/plan.ts";
import type { CostTracker } from "../cost/tracker.ts";
import type { GenerativeVideoDecision } from "./generative-video.ts";

/** Which provider actually served each capability for this variant (chain winners). */
export interface ServedProviders {
  director: string;
  directorModel: string;
  productAnalysis: string;
  transcreation: string;
  image: string;
  music: string;
  voice: string;
  sfx: string;
  transcription: string;
  video: string;
  visualQa: string;
}

export function buildManifest(opts: {
  plan: ReelPlan;
  variantId: string;
  brandId: string;
  tier: QualityTier;
  served: ServedProviders;
  clips: ShotClip[];
  timings: Record<string, number>;
  tracker: CostTracker;
  scope: string;
  fallbacks: FallbackRecord[];
  generativeVideo: GenerativeVideoDecision[];
  master: { path: string; visualHash: string; reused: boolean };
  qa: QaReport;
  output: { video: string; poster: string; plan: string; captions?: string };
  attribution?: string;
  createdAt: string;
}): ReelManifest {
  const { plan, tracker } = opts;
  const cost = tracker.breakdown(opts.scope);
  const clipById = new Map(opts.clips.map((c) => [c.shotId, c]));
  return ReelManifest.parse({
    manifestVersion: "reel-manifest/1",
    jobId: plan.metadata.jobId,
    variantId: opts.variantId,
    variantKey: plan.metadata.variantKey,
    productId: plan.product.id,
    brandId: opts.brandId,
    language: plan.language,
    market: plan.market,
    platform: plan.platform,
    tier: opts.tier,
    hookStrategy: plan.metadata.hookStrategy,
    providers: {
      director: opts.served.director,
      directorModel: opts.served.directorModel,
      productAnalysis: opts.served.productAnalysis,
      transcreation: opts.served.transcreation,
      imageProvider: opts.served.image,
      musicProvider: opts.served.music,
      voiceProvider: opts.served.voice,
      sfxProvider: opts.served.sfx,
      transcriptionProvider: opts.served.transcription,
      videoProvider: opts.served.video,
      visualQa: opts.served.visualQa,
    },
    blenderProfile: plan.render_profile.blender,
    shots: plan.shots.map((s) => {
      const c = clipById.get(s.id);
      return {
        id: s.id,
        preset: s.preset,
        technique: s.technique,
        source: s.source,
        durationMs: s.durationMs,
        cacheHit: c?.cacheHit ?? false,
        renderMs: c?.renderMs ?? 0,
      };
    }),
    durationMs: plan.durationMs,
    timings: opts.timings,
    renderTimeMs: Object.values(opts.timings).reduce((a, b) => a + b, 0),
    tokens: cost.tokens,
    cost,
    totalApiCostUsd: cost.totalApiMicros / 1e6,
    fallbacks: opts.fallbacks,
    generativeVideo: opts.generativeVideo.map((d) => ({
      shotId: d.shotId,
      used: d.used,
      reason: d.reason,
      seconds: d.seconds,
      costUsd: d.estimatedCostUsd,
    })),
    masterVideo: opts.master,
    qa: opts.qa,
    output: opts.output,
    seed: plan.metadata.seed,
    configVersion: plan.metadata.configVersion,
    createdAt: opts.createdAt,
    ...(opts.attribution ? { attribution: opts.attribution } : {}),
  });
}
