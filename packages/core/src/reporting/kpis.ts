import { computeKpis, latestPerPublication, prorateExpense, type KpiSummary } from "@cre/analytics";
import { decimalFieldToMicros, Prisma, type DbClient, type PrismaClient } from "@cre/db";
import { decimalToMicros } from "@cre/shared";

/**
 * Profit-first KPI queries shared by the dashboard and the CLI.
 * Attribution rules: clicks / conversions / revenue count at event time; impressions belong to the publication
 * (cohort of posts published in the window, latest cumulative snapshot); AI cost at usage time; expenses are
 * prorated over their period. Simulated (mock) rows are included only when asked.
 */
export interface KpiFilter {
  workspaceId: string;
  brandId?: string | null;
  from: Date;
  to: Date;
  includeSimulated: boolean;
}

export async function aiCostMicros(db: DbClient, f: KpiFilter): Promise<number> {
  const rows = await db.$queryRaw<{ total: Prisma.Decimal | null }[]>`
    SELECT COALESCE(SUM(COALESCE("actualCostUsd", "estimatedCostUsd")), 0) AS total
    FROM "GenerationUsage"
    WHERE "workspaceId" = ${f.workspaceId}
      AND status IN ('RESERVED', 'COMMITTED')
      AND "createdAt" >= ${f.from} AND "createdAt" < ${f.to}
      ${f.brandId ? Prisma.sql`AND "brandId" = ${f.brandId}` : Prisma.empty}
      ${f.includeSimulated ? Prisma.empty : Prisma.sql`AND "isMock" = false`}`;
  return decimalToMicros(rows[0]?.total ?? 0);
}

/** Runs its queries in parallel — pass the root client, not an interactive transaction. */
export async function kpiSummary(db: PrismaClient, f: KpiFilter): Promise<KpiSummary> {
  const brand = f.brandId ? { brandId: f.brandId } : {};
  const sim = f.includeSimulated ? {} : { isSimulated: false };
  const [revenue, clicks, conversions, aiCost, expenses, publications, contentCount, approvedCount] =
    await Promise.all([
      db.revenueEntry.aggregate({
        where: { workspaceId: f.workspaceId, ...brand, ...sim, occurredAt: { gte: f.from, lt: f.to } },
        _sum: { amountUsd: true },
      }),
      db.click.count({
        where: {
          workspaceId: f.workspaceId,
          ...brand,
          ...sim,
          isBot: false,
          occurredAt: { gte: f.from, lt: f.to },
        },
      }),
      db.conversion.count({
        where: {
          workspaceId: f.workspaceId,
          ...brand,
          ...sim,
          status: { not: "REVERSED" },
          occurredAt: { gte: f.from, lt: f.to },
        },
      }),
      aiCostMicros(db, f),
      db.expense.findMany({
        where: {
          workspaceId: f.workspaceId,
          ...(f.brandId ? { OR: [{ brandId: f.brandId }, { brandId: null }] } : {}),
          incurredOn: { lt: f.to },
        },
      }),
      db.publication.findMany({
        where: {
          workspaceId: f.workspaceId,
          ...brand,
          status: "PUBLISHED",
          publishedAt: { gte: f.from, lt: f.to },
          ...(f.includeSimulated ? {} : { isMock: false }),
        },
        select: { id: true, snapshots: { orderBy: { capturedAt: "desc" }, take: 1 } },
      }),
      db.contentProject.count({
        where: { workspaceId: f.workspaceId, ...brand, createdAt: { gte: f.from, lt: f.to } },
      }),
      db.contentProject.count({
        where: { workspaceId: f.workspaceId, ...brand, approvedAt: { gte: f.from, lt: f.to } },
      }),
    ]);
  const latest = latestPerPublication(publications.flatMap((p) => p.snapshots));
  const impressions = [...latest.values()].reduce((s, x) => s + (x.impressions ?? 0), 0);
  let infra = 0;
  let ads = 0;
  for (const e of expenses) {
    // shared (brand-less) expenses are split evenly in brand views by the caller if needed; here: full amount
    const amount = prorateExpense(
      { amountMicros: decimalFieldToMicros(e.amountUsd), incurredOn: e.incurredOn, periodDays: e.periodDays },
      f.from,
      f.to,
    );
    if (e.category === "ADS") ads += amount;
    else infra += amount;
  }
  return computeKpis({
    revenueMicros: decimalFieldToMicros(revenue._sum.amountUsd),
    aiCostMicros: aiCost,
    infrastructureCostMicros: infra,
    adCostMicros: ads,
    impressions,
    clicks,
    conversions,
    contentCount,
    approvedCount,
    publishedCount: publications.length,
  });
}
