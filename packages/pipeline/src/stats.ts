import { latestPerPublication, median, type EvidenceInput } from "@cre/analytics";
import { PRIORS } from "@cre/core";
import { decimalFieldToMicros, type DbClient } from "@cre/db";
import { addDays, type Micros } from "@cre/shared";

/**
 * Historical performance queries used by the strategy engine and the router.
 * Simulated (mock) data is included only when running in mock mode, so real decisions never learn from it.
 */
export interface ContentStats {
  publications: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenueMicros: Micros;
  costMicros: Micros;
  perPublicationCtr: number[];
  perPublicationImpressions: number[];
}

export async function contentStats(
  db: DbClient,
  opts: { brandId: string; since: Date; includeSimulated: boolean; productId?: string | null },
): Promise<ContentStats> {
  const pubs = await db.publication.findMany({
    where: {
      brandId: opts.brandId,
      status: "PUBLISHED",
      publishedAt: { gte: opts.since },
      ...(opts.productId ? { variant: { project: { productId: opts.productId } } } : {}),
      ...(opts.includeSimulated ? {} : { isMock: false }),
    },
    select: { id: true, variant: { select: { projectId: true } } },
  });
  if (pubs.length === 0) {
    return {
      publications: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      revenueMicros: 0,
      costMicros: 0,
      perPublicationCtr: [],
      perPublicationImpressions: [],
    };
  }
  const pubIds = pubs.map((p) => p.id);
  const projectIds = [...new Set(pubs.map((p) => p.variant.projectId))];
  const snapshots = await db.analyticsSnapshot.findMany({ where: { publicationId: { in: pubIds } } });
  const latest = latestPerPublication(snapshots);
  const clicksByPub = await db.click.groupBy({
    by: ["publicationId"],
    where: {
      publicationId: { in: pubIds },
      isBot: false,
      ...(opts.includeSimulated ? {} : { isSimulated: false }),
    },
    _count: { _all: true },
  });
  const conversions = await db.conversion.count({
    where: {
      projectId: { in: projectIds },
      status: { not: "REVERSED" },
      ...(opts.includeSimulated ? {} : { isSimulated: false }),
    },
  });
  const revenue = await db.revenueEntry.aggregate({
    where: { projectId: { in: projectIds }, ...(opts.includeSimulated ? {} : { isSimulated: false }) },
    _sum: { amountUsd: true },
  });
  const usages = await db.generationUsage.findMany({
    where: { projectId: { in: projectIds }, status: { in: ["COMMITTED", "RESERVED"] } },
    select: { estimatedCostUsd: true, actualCostUsd: true },
  });
  const perPubImpressions: number[] = [];
  const perPubCtr: number[] = [];
  let impressions = 0;
  let clicks = 0;
  for (const id of pubIds) {
    const imp = latest.get(id)?.impressions ?? 0;
    const c = clicksByPub.find((x) => x.publicationId === id)?._count._all ?? 0;
    impressions += imp;
    clicks += c;
    perPubImpressions.push(imp);
    if (imp > 0) perPubCtr.push(c / imp);
  }
  return {
    publications: pubs.length,
    impressions,
    clicks,
    conversions,
    revenueMicros: decimalFieldToMicros(revenue._sum.amountUsd),
    costMicros: usages.reduce((s, u) => s + decimalFieldToMicros(u.actualCostUsd ?? u.estimatedCostUsd), 0),
    perPublicationCtr: perPubCtr,
    perPublicationImpressions: perPubImpressions,
  };
}

/** Brand baseline for opportunity scoring: history blended with conservative priors by sample size. */
export async function brandBaseline(
  db: DbClient,
  brandId: string,
  now: Date,
  includeSimulated: boolean,
  outcome: string,
): Promise<{ expectedImpressions: number; ctr: number; conversionRate: number; sampleSize: number }> {
  const stats = await contentStats(db, { brandId, since: addDays(now, -90), includeSimulated });
  const priorCvr = PRIORS.conversionRate[outcome] ?? 0.03;
  const w = Math.min(1, stats.publications / 10);
  const histImpressions = median(stats.perPublicationImpressions) ?? PRIORS.expectedImpressions;
  const histCtr = stats.impressions > 0 ? stats.clicks / stats.impressions : PRIORS.ctr;
  const histCvr = stats.clicks > 20 ? stats.conversions / stats.clicks : priorCvr;
  return {
    expectedImpressions: Math.round(w * histImpressions + (1 - w) * PRIORS.expectedImpressions),
    ctr: w * histCtr + (1 - w) * PRIORS.ctr,
    conversionRate: w * histCvr + (1 - w) * priorCvr,
    sampleSize: stats.publications,
  };
}

/** Evidence about a product for the router (UNPROVEN … PROVEN_WINNER). */
export async function productEvidence(
  db: DbClient,
  brandId: string,
  productId: string | null,
  now: Date,
  includeSimulated: boolean,
): Promise<EvidenceInput> {
  const since = addDays(now, -90);
  const brand = await contentStats(db, { brandId, since, includeSimulated });
  if (!productId) {
    return {
      sampleSize: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      revenueMicros: 0,
      costMicros: 0,
      brandMedianCtr: median(brand.perPublicationCtr),
    };
  }
  const product = await contentStats(db, { brandId, since, includeSimulated, productId });
  return {
    sampleSize: product.publications,
    impressions: product.impressions,
    clicks: product.clicks,
    conversions: product.conversions,
    revenueMicros: product.revenueMicros,
    costMicros: product.costMicros,
    brandMedianCtr: median(brand.perPublicationCtr),
  };
}
