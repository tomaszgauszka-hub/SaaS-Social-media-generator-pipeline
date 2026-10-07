import { latestPerPublication, prorateExpense, roi } from "@cre/analytics";
import { decimalFieldToMicros, Prisma, type PrismaClient } from "@cre/db";
import { decimalToMicros, type Micros } from "@cre/shared";
import type { KpiFilter } from "./kpis.ts";

/**
 * Profitability view: revenue − AI cost (− infrastructure − ads at brand/day level) per brand, product, platform,
 * content or day. AI cost of a master creative is shared by its platform variants, so per-platform cost is the
 * project's cost split evenly across its publications.
 */
export type ProfitDimension = "brand" | "product" | "platform" | "content" | "day";

export interface ProfitRow {
  key: string;
  label: string;
  impressions: number;
  clicks: number;
  conversions: number;
  revenueMicros: Micros;
  aiCostMicros: Micros;
  otherCostMicros: Micros;
  profitMicros: Micros;
  roi: number | null;
}

type Acc = Omit<ProfitRow, "label" | "profitMicros" | "roi">;

function acc(map: Map<string, Acc>, key: string | null | undefined): Acc | null {
  if (!key) return null;
  let row = map.get(key);
  if (!row) {
    row = {
      key,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      revenueMicros: 0,
      aiCostMicros: 0,
      otherCostMicros: 0,
    };
    map.set(key, row);
  }
  return row;
}

function dayKey(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export async function profitability(
  db: PrismaClient,
  f: KpiFilter & { dimension: ProfitDimension; timeZone?: string },
): Promise<ProfitRow[]> {
  const tz = f.timeZone ?? "UTC";
  const ws = { workspaceId: f.workspaceId, ...(f.brandId ? { brandId: f.brandId } : {}) };
  const sim = f.includeSimulated ? {} : { isSimulated: false };
  const range = { gte: f.from, lt: f.to };
  const [revenue, clicks, conversions, usage, pubs, expenses] = await Promise.all([
    db.revenueEntry.findMany({
      where: { ...ws, ...sim, occurredAt: range },
      select: {
        brandId: true,
        productId: true,
        platform: true,
        projectId: true,
        amountUsd: true,
        occurredAt: true,
      },
    }),
    db.click.findMany({
      where: { ...ws, ...sim, isBot: false, occurredAt: range },
      select: { brandId: true, productId: true, platform: true, projectId: true, occurredAt: true },
    }),
    db.conversion.findMany({
      where: { ...ws, ...sim, status: { not: "REVERSED" }, occurredAt: range },
      select: { brandId: true, productId: true, platform: true, projectId: true, occurredAt: true },
    }),
    db.$queryRaw<
      { brandId: string | null; projectId: string | null; createdAt: Date; cost: Prisma.Decimal }[]
    >`
      SELECT "brandId", "projectId", "createdAt", COALESCE("actualCostUsd", "estimatedCostUsd") AS cost
      FROM "GenerationUsage"
      WHERE "workspaceId" = ${f.workspaceId} AND status IN ('RESERVED', 'COMMITTED')
        AND "createdAt" >= ${f.from} AND "createdAt" < ${f.to}
        ${f.brandId ? Prisma.sql`AND "brandId" = ${f.brandId}` : Prisma.empty}
        ${f.includeSimulated ? Prisma.empty : Prisma.sql`AND "isMock" = false`}`,
    db.publication.findMany({
      where: { ...ws, status: "PUBLISHED", ...(f.includeSimulated ? {} : { isMock: false }) },
      select: {
        id: true,
        brandId: true,
        platform: true,
        publishedAt: true,
        variant: { select: { projectId: true, project: { select: { productId: true } } } },
        snapshots: { orderBy: { capturedAt: "desc" }, take: 1 },
      },
    }),
    f.dimension === "brand" || f.dimension === "day"
      ? db.expense.findMany({
          where: {
            workspaceId: f.workspaceId,
            ...(f.brandId ? { brandId: f.brandId } : {}),
            incurredOn: { lt: f.to },
          },
        })
      : Promise.resolve([]),
  ]);

  // project → product / brand lookups (cost rows only carry project + brand)
  const projectIds = [...new Set(usage.map((u) => u.projectId).filter((x): x is string => Boolean(x)))];
  const projects = projectIds.length
    ? await db.contentProject.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, productId: true, brandId: true },
      })
    : [];
  const productOf = new Map(projects.map((p) => [p.id, p.productId]));
  const pubsByProject = new Map<string, { platform: string }[]>();
  for (const p of pubs)
    pubsByProject.set(p.variant.projectId, [
      ...(pubsByProject.get(p.variant.projectId) ?? []),
      { platform: p.platform },
    ]);

  const rows = new Map<string, Acc>();
  const keyOf = (
    r: {
      brandId: string | null;
      productId?: string | null;
      platform?: string | null;
      projectId: string | null;
    },
    at: Date,
  ): string | null => {
    switch (f.dimension) {
      case "brand":
        return r.brandId;
      case "product":
        return r.productId ?? null;
      case "platform":
        return r.platform ?? null;
      case "content":
        return r.projectId;
      case "day":
        return dayKey(at, tz);
    }
  };

  for (const r of revenue) {
    const a = acc(rows, keyOf(r, r.occurredAt));
    if (a) a.revenueMicros += decimalFieldToMicros(r.amountUsd);
  }
  for (const c of clicks) {
    const a = acc(rows, keyOf(c, c.occurredAt));
    if (a) a.clicks++;
  }
  for (const c of conversions) {
    const a = acc(rows, keyOf(c, c.occurredAt));
    if (a) a.conversions++;
  }
  // impressions: posts published in the window (cohort), latest cumulative snapshot
  const latest = latestPerPublication(pubs.flatMap((p) => p.snapshots));
  for (const p of pubs) {
    if (!p.publishedAt || p.publishedAt < f.from || p.publishedAt >= f.to) continue;
    const a = acc(
      rows,
      keyOf(
        {
          brandId: p.brandId,
          productId: p.variant.project.productId,
          platform: p.platform,
          projectId: p.variant.projectId,
        },
        p.publishedAt,
      ),
    );
    if (a) a.impressions += latest.get(p.id)?.impressions ?? 0;
  }
  for (const u of usage) {
    const cost = decimalToMicros(u.cost);
    if (f.dimension === "platform") {
      const targets = u.projectId ? (pubsByProject.get(u.projectId) ?? []) : [];
      if (targets.length === 0) {
        const a = acc(rows, "UNPUBLISHED");
        if (a) a.aiCostMicros += cost;
        continue;
      }
      const share = Math.round(cost / targets.length);
      for (const t of targets) {
        const a = acc(rows, t.platform);
        if (a) a.aiCostMicros += share;
      }
      continue;
    }
    const a = acc(
      rows,
      keyOf(
        {
          brandId: u.brandId,
          productId: u.projectId ? (productOf.get(u.projectId) ?? null) : null,
          projectId: u.projectId,
        },
        u.createdAt,
      ),
    );
    if (a) a.aiCostMicros += cost;
  }
  if (f.dimension === "day") {
    for (let t = new Date(f.from); t < f.to; t = new Date(t.getTime() + 86_400_000)) {
      const a = acc(rows, dayKey(t, tz));
      const end = new Date(t.getTime() + 86_400_000);
      for (const e of expenses) {
        if (a)
          a.otherCostMicros += prorateExpense(
            {
              amountMicros: decimalFieldToMicros(e.amountUsd),
              incurredOn: e.incurredOn,
              periodDays: e.periodDays,
            },
            t,
            end,
          );
      }
    }
  } else if (f.dimension === "brand") {
    for (const e of expenses) {
      const a = acc(rows, e.brandId ?? "SHARED");
      if (a)
        a.otherCostMicros += prorateExpense(
          {
            amountMicros: decimalFieldToMicros(e.amountUsd),
            incurredOn: e.incurredOn,
            periodDays: e.periodDays,
          },
          f.from,
          f.to,
        );
    }
  }

  const labels = await labelsFor(db, f.dimension, [...rows.keys()]);
  return [...rows.values()]
    .map((r) => {
      const cost = r.aiCostMicros + r.otherCostMicros;
      return {
        ...r,
        label: labels.get(r.key) ?? r.key,
        profitMicros: r.revenueMicros - cost,
        roi: roi(r.revenueMicros, cost),
      };
    })
    .sort((a, b) => (f.dimension === "day" ? a.key.localeCompare(b.key) : b.profitMicros - a.profitMicros));
}

async function labelsFor(
  db: PrismaClient,
  dimension: ProfitDimension,
  keys: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>([
    ["UNPUBLISHED", "Not published yet"],
    ["SHARED", "Shared costs"],
  ]);
  if (dimension === "brand") {
    for (const b of await db.brand.findMany({
      where: { id: { in: keys } },
      select: { id: true, name: true },
    }))
      map.set(b.id, b.name);
  } else if (dimension === "product") {
    for (const p of await db.product.findMany({
      where: { id: { in: keys } },
      select: { id: true, title: true },
    }))
      map.set(p.id, p.title);
  } else if (dimension === "content") {
    for (const p of await db.contentProject.findMany({
      where: { id: { in: keys } },
      select: { id: true, title: true },
    }))
      map.set(p.id, p.title);
  } else if (dimension === "platform") {
    for (const k of keys) if (!map.has(k)) map.set(k, k.charAt(0) + k.slice(1).toLowerCase());
  }
  return map;
}
