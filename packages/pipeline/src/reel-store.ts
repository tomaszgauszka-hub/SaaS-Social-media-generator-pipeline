import type { Prisma, PrismaClient } from "@cre/db";
import type {
  ProductProfile,
  ReelJob,
  ReelJobState,
  ReelManifest,
  ReelOutcome,
  ReelPlan,
  ReelStore,
} from "@cre/reel";
import { toJson } from "@cre/shared";

const json = (v: unknown) => toJson(v) as Prisma.InputJsonValue;

/**
 * Prisma persistence for the reel factory: ReelJobRecord (one per order), ReelVariant (one per locale × A/B arm
 * × platform, with plan + manifest and denormalised feature columns for later conversion analysis) and the
 * ProductProfile cache shared by every reel of a product.
 */
export class PrismaReelStore implements ReelStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly workspaceId: string | null,
  ) {}

  async jobStarted(job: ReelJob, maxApiCostUsd: number): Promise<{ priorApiCostUsd: number }> {
    // a retry of an unfinished attempt (RUNNING / FAILED) carries its recorded spend; a re-run of a DONE job
    // is a new order with a fresh budget
    const prev = await this.db.reelJobRecord.findUnique({
      where: { jobId: job.jobId },
      select: { status: true, totalApiCostUsd: true },
    });
    const priorApiCostUsd = prev && prev.status !== "DONE" ? Number(prev.totalApiCostUsd) || 0 : 0;
    const data = {
      brandKey: job.brandId,
      productKey: job.productId,
      platform: job.platform,
      tier: job.tier,
      status: "RUNNING" as const,
      maxApiCostUsd,
      request: json(job),
      error: null,
      finishedAt: null,
      totalApiCostUsd: priorApiCostUsd,
    };
    await this.db.reelJobRecord.upsert({
      where: { jobId: job.jobId },
      create: { jobId: job.jobId, workspaceId: this.workspaceId, ...data },
      update: data,
    });
    return { priorApiCostUsd };
  }

  async jobFinished(
    jobId: string,
    state: ReelJobState,
    info: { totalApiCostUsd: number; timings: Record<string, number>; error?: string },
  ): Promise<void> {
    await this.db.reelJobRecord.update({
      where: { jobId },
      data: {
        status: state,
        totalApiCostUsd: info.totalApiCostUsd,
        timings: json(info.timings),
        error: info.error ?? null,
        finishedAt: new Date(),
      },
    });
  }

  async variantDelivered(manifest: ReelManifest, plan: ReelPlan): Promise<void> {
    const job = await this.db.reelJobRecord.findUniqueOrThrow({
      where: { jobId: manifest.jobId },
      select: { id: true },
    });
    const data = {
      market: manifest.market,
      tier: manifest.tier,
      hookStrategy: manifest.hookStrategy,
      directorProvider: manifest.providers.director,
      directorModel: manifest.providers.directorModel,
      musicProvider: manifest.providers.musicProvider,
      voiceProvider: manifest.providers.voiceProvider,
      sfxProvider: manifest.providers.sfxProvider,
      blenderProfile: manifest.blenderProfile,
      durationMs: manifest.durationMs,
      totalApiCostUsd: manifest.totalApiCostUsd,
      qaScore: Math.round(manifest.qa.score),
      qaPassed: manifest.qa.passed,
      visualHash: manifest.masterVideo.visualHash,
      masterReused: manifest.masterVideo.reused,
      videoPath: manifest.output.video,
      posterPath: manifest.output.poster,
      plan: json(plan),
      manifest: json(manifest),
    };
    await this.db.reelVariant.upsert({
      where: {
        jobRecordId_variantKey_locale_platform: {
          jobRecordId: job.id,
          variantKey: manifest.variantKey,
          locale: manifest.language,
          platform: manifest.platform,
        },
      },
      create: {
        jobRecordId: job.id,
        variantKey: manifest.variantKey,
        locale: manifest.language,
        platform: manifest.platform,
        ...data,
      },
      update: data,
    });
  }

  async getProfile(
    productKey: string,
    sourceHash: string,
    analyzerVersion: string,
  ): Promise<ProductProfile | null> {
    const row = await this.db.productProfileCache.findUnique({
      where: { productKey_sourceHash_analyzerVersion: { productKey, sourceHash, analyzerVersion } },
    });
    return row ? (row.profile as unknown as ProductProfile) : null;
  }

  async putProfile(productKey: string, profile: ProductProfile, analyzerVersion: string): Promise<void> {
    const key = { productKey, sourceHash: profile.sourceHash, analyzerVersion };
    await this.db.productProfileCache.upsert({
      where: { productKey_sourceHash_analyzerVersion: key },
      create: {
        ...key,
        provider: profile.analyzer.provider,
        model: profile.analyzer.model,
        profile: json(profile),
      },
      update: {
        provider: profile.analyzer.provider,
        model: profile.analyzer.model,
        profile: json(profile),
      },
    });
  }

  /**
   * Real platform metrics of a delivered variant (views, completion, CTR, conversions …) — the data later
   * analysis needs per hook / shot / voice / music / CTA. Returns the variant's hook strategy and locale.
   */
  async recordOutcome(
    key: { jobId: string; variantKey: string; locale: string; platform: string },
    o: ReelOutcome,
  ): Promise<{ hookStrategy: string; locale: string }> {
    const job = await this.db.reelJobRecord.findUniqueOrThrow({
      where: { jobId: key.jobId },
      select: { id: true },
    });
    const v = await this.db.reelVariant.findUniqueOrThrow({
      where: {
        jobRecordId_variantKey_locale_platform: {
          jobRecordId: job.id,
          variantKey: key.variantKey,
          locale: key.locale,
          platform: key.platform,
        },
      },
      select: { id: true, hookStrategy: true, locale: true },
    });
    await this.db.reelOutcomeSnapshot.create({
      data: {
        variantId: v.id,
        collectedAt: new Date(o.collectedAt),
        views: o.views ?? null,
        watchTimeMs: o.watchTimeMs !== undefined ? BigInt(o.watchTimeMs) : null,
        completionRate: o.completionRate ?? null,
        ctr: o.ctr ?? null,
        conversions: o.conversions ?? null,
        sales: o.sales ?? null,
        revenueUsd: o.revenueMicros !== undefined ? o.revenueMicros / 1e6 : null,
        likes: o.likes ?? null,
        comments: o.comments ?? null,
        shares: o.shares ?? null,
        raw: json(o),
      },
    });
    return { hookStrategy: v.hookStrategy, locale: v.locale };
  }
}
