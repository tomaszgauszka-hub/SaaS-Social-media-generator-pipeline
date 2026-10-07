import { buildPerformanceProfile, profileToPromptText, type ContentPerformanceRecord } from "@cre/analytics";
import { ANALYTICS_DEFAULTS } from "@cre/config";
import { PRIORS, recordConversion, valuePerConversion } from "@cre/core";
import { decimalFieldToMicros, decimalToNumber, type ConversionType, type Prisma } from "@cre/db";
import type { PlatformMetrics } from "@cre/publishing";
import { addDays, addHours, idempotencyKey, randomCode, seededRandom, toJson } from "@cre/shared";
import type { PipelineContext } from "../context.ts";
import { payloadString, type JobExecution } from "../job-types.ts";
import { economicOutcomeFor } from "../prompt-context.ts";
import { accountRef, loadSocialCredentials, publisherFor } from "../social.ts";
import { enqueue } from "../outbox.ts";

const CONVERSION_TYPE: Record<string, ConversionType> = {
  AFFILIATE_CLICK: "SALE",
  SALE: "SALE",
  LEAD: "LEAD",
  SERVICE_INQUIRY: "INQUIRY",
  EMAIL_SIGNUP: "SIGNUP",
};

const REFERRER: Record<string, string> = {
  INSTAGRAM: "l.instagram.com",
  FACEBOOK: "l.facebook.com",
  TIKTOK: "www.tiktok.com",
};
const IN_APP: Record<string, string> = {
  INSTAGRAM: "Instagram in-app",
  FACEBOOK: "Facebook in-app",
  TIKTOK: "TikTok in-app",
};

type CollectPublication = Awaited<ReturnType<typeof loadForAnalytics>>;

function loadForAnalytics(ctx: PipelineContext, publicationId: string) {
  return ctx.prisma.publication.findUniqueOrThrow({
    where: { id: publicationId },
    include: {
      socialAccount: true,
      variant: {
        include: {
          trackedLink: { include: { affiliateLink: true } },
          project: { include: { product: true } },
        },
      },
      snapshots: { orderBy: { capturedAt: "desc" }, take: 1, select: { capturedAt: true } },
    },
  });
}

/**
 * MOCK MODE ONLY: turn simulated platform metrics into simulated tracking-link clicks and affiliate conversions,
 * so the dashboard can show the whole funnel (impressions → clicks → conversions → revenue → profit) at zero spend.
 * Everything created here is flagged isSimulated and excluded from real-mode decisions.
 */
export async function simulateFunnel(
  ctx: PipelineContext,
  pub: CollectPublication,
  metrics: PlatformMetrics,
  now: Date,
): Promise<{ clicks: number; conversions: number }> {
  const link = pub.variant.trackedLink;
  const project = pub.variant.project;
  if (!link || !pub.publishedAt) return { clicks: 0, conversions: 0 };
  const existing = await ctx.prisma.click.count({ where: { publicationId: pub.id, isSimulated: true } });
  const add = Math.max(0, (metrics.outboundClicks ?? 0) - existing);
  if (add === 0) return { clicks: 0, conversions: 0 };
  const rnd = seededRandom(`${pub.id}:${existing}`);
  const from = (pub.snapshots[0]?.capturedAt ?? pub.publishedAt).getTime();
  const span = Math.max(60_000, now.getTime() - from);
  const clicks = Array.from({ length: add }, () => ({
    clickId: `sim${randomCode(13)}`,
    trackedLinkId: link.id,
    workspaceId: pub.workspaceId,
    brandId: pub.brandId,
    projectId: project.id,
    variantId: pub.variantId,
    publicationId: pub.id,
    productId: link.productId,
    platform: pub.platform,
    campaign: link.campaign,
    occurredAt: new Date(from + Math.floor(rnd() * span)),
    referrerHost: REFERRER[pub.platform] ?? null,
    utmSource: link.utmSource,
    utmMedium: link.utmMedium,
    utmCampaign: link.utmCampaign,
    utmContent: link.utmContent,
    deviceType: rnd() < 0.93 ? "mobile" : "desktop",
    osFamily: rnd() < 0.55 ? "iOS" : "Android",
    browserFamily: IN_APP[pub.platform] ?? "Other",
    isBot: false,
    isSimulated: true,
  }));
  await ctx.prisma.click.createMany({ data: clicks });

  const product = project.product;
  if (!product) return { clicks: add, conversions: 0 };
  const outcome = economicOutcomeFor(product);
  const quality = 0.6 + ((project.qaScore ?? 75) / 100) * 0.8;
  const cvr = (PRIORS.conversionRate[outcome] ?? 0.03) * quality;
  const priceMicros = product.price ? decimalFieldToMicros(product.price) : null;
  const commissionMicros = valuePerConversion({
    priceMicros,
    commissionRate: decimalToNumber(product.commissionRate),
    commissionFixedMicros: product.commissionFixedUsd
      ? decimalFieldToMicros(product.commissionFixedUsd)
      : null,
    kind: product.kind,
    economicOutcome: outcome,
  });
  let conversions = 0;
  for (const click of clicks) {
    if (rnd() >= cvr) continue;
    conversions++;
    await recordConversion(ctx.prisma, {
      workspaceId: pub.workspaceId,
      source: "mock",
      affiliateProgramId: link.affiliateLink?.affiliateProgramId ?? null,
      externalId: `sim-${click.clickId}`,
      clickId: click.clickId,
      type: CONVERSION_TYPE[outcome] ?? "SALE",
      status: rnd() < 0.85 ? "APPROVED" : "PENDING",
      occurredAt: new Date(click.occurredAt.getTime() + Math.floor(rnd() * 3 * 3_600_000)),
      orderValueMicros: outcome === "LEAD" ? null : priceMicros,
      commissionMicros,
      isSimulated: true,
      raw: { simulated: true },
    });
  }
  return { clicks: add, conversions };
}

/** analytics.collect — one cumulative metrics snapshot (time series, never overwritten), then schedule the next. */
export async function analyticsCollectHandler(exec: JobExecution) {
  const { ctx } = exec;
  const publicationId = payloadString(exec, "publicationId");
  const index = Number(exec.payload.index ?? 0);
  const pub = await loadForAnalytics(ctx, publicationId);
  if (pub.status !== "PUBLISHED" || !pub.externalPostId || !pub.publishedAt)
    return { skipped: true, status: pub.status };
  const now = ctx.clock.now();
  const project = pub.variant.project;
  const publisher = pub.isMock ? ctx.mockPublisher : publisherFor(ctx, pub.socialAccount);
  const credentials = await loadSocialCredentials(ctx, pub.socialAccount, publisher);
  const metrics = await publisher.getAnalytics(pub.externalPostId, {
    account: accountRef(pub.socialAccount),
    credentials,
    publishedAt: pub.publishedAt,
    now,
    signal: exec.signal,
    hints: {
      qaScore: project.qaScore,
      hookStyle: project.hookStyle,
      durationMs: project.durationMs,
      seed: pub.id,
    },
  });
  await ctx.prisma.analyticsSnapshot.create({
    data: {
      publicationId: pub.id,
      capturedAt: now,
      source: publisher.isMock ? "MOCK" : "PLATFORM_API",
      impressions: metrics.impressions,
      reach: metrics.reach,
      plays: metrics.plays,
      views3s: metrics.views3s,
      completionRate: metrics.completionRate,
      avgWatchTimeMs: metrics.avgWatchTimeMs,
      likes: metrics.likes,
      comments: metrics.comments,
      saves: metrics.saves,
      shares: metrics.shares,
      profileVisits: metrics.profileVisits,
      outboundClicks: metrics.outboundClicks,
      follows: metrics.follows,
      ...(metrics.raw ? { raw: toJson(metrics.raw) as Prisma.InputJsonValue } : {}),
    },
  });
  const funnel = publisher.isMock
    ? await simulateFunnel(ctx, pub, metrics, now)
    : { clicks: 0, conversions: 0 };

  const offsets = ANALYTICS_DEFAULTS.snapshotOffsetsHours;
  const nextOffset = offsets[index + 1];
  const nextAt = nextOffset !== undefined ? addHours(pub.publishedAt, nextOffset) : null;
  const until = pub.analyticsUntil ?? addDays(pub.publishedAt, ANALYTICS_DEFAULTS.windowDays);
  if (nextAt && nextAt.getTime() <= until.getTime()) {
    await ctx.prisma.$transaction(async (tx) => {
      await tx.publication.update({ where: { id: pub.id }, data: { nextAnalyticsAt: nextAt } });
      await enqueue(ctx, tx, {
        type: "analytics.collect",
        payload: { publicationId: pub.id, index: index + 1 },
        idempotencyKey: idempotencyKey("analytics", { publicationId: pub.id, index: index + 1 }),
        workspaceId: pub.workspaceId,
        brandId: pub.brandId,
        projectId: project.id,
        variantId: pub.variantId,
        publicationId: pub.id,
        runAt: nextAt,
      });
    });
  } else {
    await ctx.prisma.publication.update({ where: { id: pub.id }, data: { nextAnalyticsAt: null } });
  }
  // refresh the brand's learning profile after the 24 h snapshot and at the end of the window
  if (offsets[index] === 24 || !nextAt) await enqueueProfile(ctx, pub.workspaceId, pub.brandId, now);
  return {
    index,
    impressions: metrics.impressions,
    outboundClicks: metrics.outboundClicks,
    simulated: funnel,
    nextAt: nextAt?.toISOString() ?? null,
  };
}

export async function enqueueProfile(
  ctx: PipelineContext,
  workspaceId: string,
  brandId: string,
  now: Date,
): Promise<void> {
  await enqueue(ctx, ctx.prisma, {
    type: "analytics.profile",
    payload: { brandId },
    idempotencyKey: idempotencyKey("profile", { brandId, hour: now.toISOString().slice(0, 13) }),
    workspaceId,
    brandId,
    runAt: now,
  });
}

/** Performance record per publication (cost of the shared master creative is split across its publications). */
export async function performanceRecords(
  ctx: PipelineContext,
  brandId: string,
  since: Date,
  includeSimulated: boolean,
): Promise<ContentPerformanceRecord[]> {
  const pubs = await ctx.prisma.publication.findMany({
    where: {
      brandId,
      status: "PUBLISHED",
      publishedAt: { gte: since },
      ...(includeSimulated ? {} : { isMock: false }),
    },
    include: {
      variant: { include: { project: { include: { template: true, product: true } } } },
      snapshots: { orderBy: { capturedAt: "desc" }, take: 1 },
    },
  });
  if (pubs.length === 0) return [];
  const pubIds = pubs.map((p) => p.id);
  const variantIds = pubs.map((p) => p.variantId);
  const projectIds = [...new Set(pubs.map((p) => p.variant.projectId))];
  const sim = includeSimulated ? {} : { isSimulated: false };
  const [clicks, conversions, revenue, usage] = await Promise.all([
    ctx.prisma.click.groupBy({
      by: ["publicationId"],
      where: { publicationId: { in: pubIds }, isBot: false, ...sim },
      _count: { _all: true },
    }),
    ctx.prisma.conversion.groupBy({
      by: ["variantId"],
      where: { variantId: { in: variantIds }, status: { not: "REVERSED" }, ...sim },
      _count: { _all: true },
    }),
    ctx.prisma.revenueEntry.groupBy({
      by: ["variantId"],
      where: { variantId: { in: variantIds }, ...sim },
      _sum: { amountUsd: true },
    }),
    ctx.prisma.generationUsage.groupBy({
      by: ["projectId"],
      where: { projectId: { in: projectIds }, status: { in: ["RESERVED", "COMMITTED"] } },
      _sum: { estimatedCostUsd: true, actualCostUsd: true },
    }),
  ]);
  const pubsPerProject = new Map<string, number>();
  for (const p of pubs)
    pubsPerProject.set(p.variant.projectId, (pubsPerProject.get(p.variant.projectId) ?? 0) + 1);
  return pubs.map((p) => {
    const project = p.variant.project;
    const snap = p.snapshots[0];
    const u = usage.find((x) => x.projectId === project.id)?._sum;
    const cost = u ? decimalFieldToMicros(u.actualCostUsd ?? u.estimatedCostUsd) : 0;
    return {
      projectId: project.id,
      platform: p.platform,
      hookStyle: project.hookStyle,
      angle: project.angle,
      ctaType: project.ctaType,
      durationMs: project.durationMs,
      templateKey: project.template?.key ?? null,
      tier: project.tier,
      productTitle: project.product?.title ?? null,
      postedAt: p.publishedAt,
      impressions: snap?.impressions ?? 0,
      clicks: clicks.find((c) => c.publicationId === p.id)?._count._all ?? 0,
      conversions: conversions.find((c) => c.variantId === p.variantId)?._count._all ?? 0,
      revenueMicros: decimalFieldToMicros(
        revenue.find((r) => r.variantId === p.variantId)?._sum.amountUsd ?? null,
      ),
      costMicros: Math.round(cost / (pubsPerProject.get(project.id) ?? 1)),
      completionRate: snap?.completionRate ?? null,
    };
  });
}

/** analytics.profile — the learning loop: winners/losers by creative feature → text for future prompts. */
export async function analyticsProfileHandler(exec: JobExecution) {
  const { ctx } = exec;
  const brandId = payloadString(exec, "brandId");
  const now = ctx.clock.now();
  const brand = await ctx.prisma.brand.findUniqueOrThrow({
    where: { id: brandId },
    select: { id: true, timezone: true },
  });
  const since = addDays(now, -90);
  const records = await performanceRecords(ctx, brand.id, since, ctx.env.MOCK_SOCIAL);
  const summary = buildPerformanceProfile(records, { timeZone: brand.timezone });
  const promptText = profileToPromptText(summary);
  const last = await ctx.prisma.brandPerformanceProfile.findFirst({
    where: { brandId },
    orderBy: { version: "desc" },
  });
  const profile = await ctx.prisma.brandPerformanceProfile.create({
    data: {
      brandId,
      version: (last?.version ?? 0) + 1,
      windowStart: since,
      windowEnd: now,
      sampleSize: summary.sampleSize,
      summary: toJson(summary) as Prisma.InputJsonValue,
      promptText,
    },
  });
  exec.log.info(
    {
      version: profile.version,
      sampleSize: summary.sampleSize,
      high: summary.high.length,
      low: summary.low.length,
    },
    "performance profile updated",
  );
  return { version: profile.version, sampleSize: summary.sampleSize };
}
