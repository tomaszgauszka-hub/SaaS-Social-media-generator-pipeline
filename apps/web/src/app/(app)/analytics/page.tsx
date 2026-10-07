import type { Metadata } from "next";
import { kpiSummary, profitability } from "@cre/core";
import { ColumnChart, LineChart } from "@/components/charts";
import { ProfitTable } from "@/components/profit-table";
import { Card, FilterLink, Kpi, PageHeader, SimulatedNote } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { num, pct, usd } from "@/lib/format";
import { dayLabels, includeSimulated, parseRange, periodFor, RANGES } from "@/lib/period";

export const metadata: Metadata = { title: "Analytics" };

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; brand?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const range = parseRange(sp.range);
  const tz = user.timezone;
  const p = periodFor(range, tz);
  const sim = includeSimulated();
  const prisma = db();
  const brands = await prisma.brand.findMany({
    where: { workspaceId: user.workspaceId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const brandId = brands.some((b) => b.id === sp.brand) ? sp.brand : undefined;
  const base = {
    workspaceId: user.workspaceId,
    brandId: brandId ?? null,
    from: p.from,
    to: p.to,
    includeSimulated: sim,
    timeZone: tz,
  };
  const [kpis, byDay, byBrand, byPlatform, byProduct, byContent, profiles] = await Promise.all([
    kpiSummary(prisma, base),
    profitability(prisma, { ...base, dimension: "day" }),
    profitability(prisma, { ...base, dimension: "brand" }),
    profitability(prisma, { ...base, dimension: "platform" }),
    profitability(prisma, { ...base, dimension: "product" }),
    profitability(prisma, { ...base, dimension: "content" }),
    prisma.brandPerformanceProfile.findMany({
      where: { brand: { workspaceId: user.workspaceId, ...(brandId ? { id: brandId } : {}) } },
      orderBy: { version: "desc" },
      distinct: ["brandId"],
      include: { brand: { select: { name: true } } },
    }),
  ]);
  const days = dayLabels(p.from, p.days, tz);
  const dayMap = new Map(byDay.map((d) => [d.key, d]));
  const href = (over: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = { range, brand: brandId, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
    return `/analytics?${params.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Analytics & profitability"
        subtitle="Revenue − AI cost − infrastructure − ads = profit, by brand, platform, product, content and day."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {Object.keys(RANGES).map((r) => (
          <FilterLink key={r} href={href({ range: r })} active={range === r}>
            Last {r.replace("d", " days")}
          </FilterLink>
        ))}
        <span className="mx-1 hidden w-px bg-zinc-200 sm:block" />
        <FilterLink href={href({ brand: undefined })} active={!brandId}>
          All brands
        </FilterLink>
        {brands.map((b) => (
          <FilterLink key={b.id} href={href({ brand: b.id })} active={brandId === b.id}>
            {b.name}
          </FilterLink>
        ))}
      </div>
      <SimulatedNote show={sim} />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi
          label="Profit"
          value={usd(kpis.profitMicros)}
          tone={kpis.profitMicros >= 0 ? "good" : "bad"}
          hint={`ROI ${pct(kpis.roi, 0)}`}
        />
        <Kpi label="Revenue" value={usd(kpis.revenueMicros)} hint={`RPM ${usd(kpis.rpmMicros)}`} />
        <Kpi
          label="AI cost"
          value={usd(kpis.aiCostMicros)}
          hint={`${usd(kpis.costPerPublishedMicros)} / post`}
        />
        <Kpi label="Impressions" value={num(kpis.impressions)} hint={`${kpis.publishedCount} posts`} />
        <Kpi label="Clicks" value={num(kpis.clicks)} hint={`CTR ${pct(kpis.ctr, 2)}`} />
        <Kpi
          label="Conversions"
          value={num(kpis.conversions)}
          hint={`CVR ${pct(kpis.conversionRate)} · ${usd(kpis.revenuePerClickMicros)}/click`}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Revenue vs. cost per day">
          <LineChart
            title="Revenue and total cost per day (USD)"
            labels={days.map((d) => d.label)}
            unit="usd"
            series={[
              {
                key: "revenue",
                label: "Revenue",
                values: days.map((d) => dayMap.get(d.key)?.revenueMicros ?? 0),
              },
              {
                key: "cost",
                label: "Cost (AI + other)",
                values: days.map(
                  (d) => (dayMap.get(d.key)?.aiCostMicros ?? 0) + (dayMap.get(d.key)?.otherCostMicros ?? 0),
                ),
              },
            ]}
          />
        </Card>
        <Card title="Clicks per day">
          <ColumnChart
            title="Tracked-link clicks per day"
            labels={days.map((d) => d.label)}
            unit="count"
            values={days.map((d) => dayMap.get(d.key)?.clicks ?? 0)}
          />
        </Card>
      </div>
      <div className="mt-4 grid gap-4 2xl:grid-cols-2">
        <Card title="By platform">
          <ProfitTable rows={byPlatform} label="Platform" />
        </Card>
        <Card title="By brand">
          <ProfitTable rows={byBrand} label="Brand" linkPrefix="/brands/" />
        </Card>
        <Card title="By product">
          <ProfitTable rows={byProduct} label="Product" />
        </Card>
        <Card title="Top content">
          <ProfitTable rows={byContent} label="Content" linkPrefix="/content/" limit={15} />
        </Card>
      </div>
      <Card title="Learning loop — what the generator is told" className="mt-4">
        {profiles.length === 0 ? (
          <p className="text-sm text-zinc-500">Profiles appear after posts collect analytics.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {profiles.map((pr) => (
              <div key={pr.id}>
                <h3 className="text-sm font-semibold">
                  {pr.brand.name}{" "}
                  <span className="font-normal text-zinc-500">
                    v{pr.version} · n={pr.sampleSize}
                  </span>
                </h3>
                <pre className="mt-1 text-xs whitespace-pre-wrap text-zinc-700">
                  {pr.promptText || "Not enough data yet."}
                </pre>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
