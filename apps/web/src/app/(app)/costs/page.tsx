import type { Metadata } from "next";
import { BudgetGuard, profitability } from "@cre/core";
import { decimalFieldToMicros, type Prisma } from "@cre/db";
import { decimalToMicros, usdToMicros } from "@cre/shared";
import { updateBudgetAction } from "@/app/actions/brands";
import { ActionForm } from "@/components/action-form";
import { ColumnChart } from "@/components/charts";
import { Badge, BudgetMeter, Card, FilterLink, Kpi, PageHeader, Table } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db, env } from "@/lib/db";
import { num, usd } from "@/lib/format";
import { dayLabels, parseRange, periodFor, RANGES } from "@/lib/period";

export const metadata: Metadata = { title: "Costs & budgets" };

interface UsageGroup {
  provider: string;
  model: string;
  operation: string;
  is_mock: boolean;
  calls: bigint;
  cost: Prisma.Decimal;
}

export default async function CostsPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const user = await requireUser();
  const range = parseRange((await searchParams).range);
  const tz = user.timezone;
  const p = periodFor(range, tz);
  const prisma = db();
  const e = env();
  const guard = new BudgetGuard(prisma, { hardDailyMicros: usdToMicros(e.HARD_DAILY_BUDGET_USD) });
  const [groups, daily, brands, limits, spendWs, approved, published, blocked, produced, conversions] =
    await Promise.all([
      prisma.$queryRaw<UsageGroup[]>`
      SELECT provider, model, operation::text AS operation, "isMock" AS is_mock, COUNT(*) AS calls,
             COALESCE(SUM(COALESCE("actualCostUsd", "estimatedCostUsd")), 0) AS cost
      FROM "GenerationUsage"
      WHERE "workspaceId" = ${user.workspaceId} AND status IN ('RESERVED', 'COMMITTED') AND "createdAt" >= ${p.from} AND "createdAt" < ${p.to}
      GROUP BY provider, model, operation, "isMock"
      ORDER BY cost DESC`,
      profitability(prisma, {
        workspaceId: user.workspaceId,
        from: p.from,
        to: p.to,
        includeSimulated: true,
        dimension: "day",
        timeZone: tz,
      }),
      prisma.brand.findMany({
        where: { workspaceId: user.workspaceId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, timezone: true },
      }),
      guard.getLimits(prisma, user.workspaceId, null),
      guard.getSpend(prisma, { workspaceId: user.workspaceId, brandId: null, projectId: null, timeZone: tz }),
      prisma.contentProject.count({
        where: { workspaceId: user.workspaceId, approvedAt: { gte: p.from, lt: p.to } },
      }),
      prisma.publication.count({
        where: { workspaceId: user.workspaceId, status: "PUBLISHED", publishedAt: { gte: p.from, lt: p.to } },
      }),
      prisma.contentProject.count({ where: { workspaceId: user.workspaceId, status: "BUDGET_BLOCKED" } }),
      prisma.contentProject.count({
        where: { workspaceId: user.workspaceId, createdAt: { gte: p.from, lt: p.to } },
      }),
      prisma.conversion.count({
        where: {
          workspaceId: user.workspaceId,
          status: { not: "REVERSED" },
          occurredAt: { gte: p.from, lt: p.to },
        },
      }),
    ]);
  const brandBudgets = await Promise.all(
    brands.map(async (b) => ({
      brand: b,
      limits: (await guard.getLimits(prisma, user.workspaceId, b.id)).brand,
      spend: await guard.getSpend(prisma, {
        workspaceId: user.workspaceId,
        brandId: b.id,
        projectId: null,
        timeZone: b.timezone,
      }),
    })),
  );
  const wsBudget = await prisma.budget.findUnique({ where: { scopeKey: `workspace:${user.workspaceId}` } });
  const total = groups.reduce((s, g) => s + decimalToMicros(g.cost), 0);
  const real = groups.filter((g) => !g.is_mock).reduce((s, g) => s + decimalToMicros(g.cost), 0);
  const days = dayLabels(p.from, p.days, tz);
  const dayMap = new Map(daily.map((d) => [d.key, d.aiCostMicros]));
  const fmt = (v: number) => usd(v);
  const m = (v: Prisma.Decimal | null | undefined) =>
    v ? (decimalFieldToMicros(v) / 1_000_000).toString() : "";

  return (
    <>
      <PageHeader
        title="Costs & budgets"
        subtitle="Every external AI/API call is estimated, reserved against the budgets, executed, then settled with its actual cost."
      />
      <div className="mb-4 flex gap-2">
        {Object.keys(RANGES).map((r) => (
          <FilterLink key={r} href={`/costs?range=${r}`} active={range === r}>
            Last {r.replace("d", " days")}
          </FilterLink>
        ))}
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Kpi
          label="AI spend"
          value={usd(total)}
          hint={`${usd(real)} real · ${usd(total - real)} simulated`}
        />
        <Kpi
          label="Cost / content"
          value={produced ? usd(Math.round(total / produced)) : "—"}
          hint={`${produced} items started`}
        />
        <Kpi
          label="Cost / approved"
          value={approved ? usd(Math.round(total / approved)) : "—"}
          hint={`${approved} approved`}
          tone={approved && total / approved > 500_000 ? "bad" : "neutral"}
        />
        <Kpi
          label="Cost / published"
          value={published ? usd(Math.round(total / published)) : "—"}
          hint={`${published} posts`}
        />
        <Kpi
          label="Cost / conversion"
          value={conversions ? usd(Math.round(total / conversions)) : "—"}
          hint={`${num(conversions)} conversions`}
        />
        <Kpi
          label="Real spend today"
          value={usd(spendWs.systemRealDay)}
          hint={`hard cap ${usd(usdToMicros(e.HARD_DAILY_BUDGET_USD))}`}
          tone={spendWs.systemRealDay > usdToMicros(e.HARD_DAILY_BUDGET_USD) * 0.8 ? "bad" : "neutral"}
        />
        <Kpi
          label="Budget-blocked"
          value={blocked}
          tone={blocked ? "bad" : "neutral"}
          hint="resume automatically"
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="AI spend per day">
          <ColumnChart
            title="AI spend per day (USD, incl. simulated)"
            labels={days.map((d) => d.label)}
            unit="usd"
            values={days.map((d) => dayMap.get(d.key) ?? 0)}
          />
        </Card>
        <Card title="By provider & operation">
          <Table
            head={
              <>
                <th className="th">Provider / model</th>
                <th className="th">Operation</th>
                <th className="th">Calls</th>
                <th className="th">Cost</th>
              </>
            }
          >
            {groups.map((g) => (
              <tr key={`${g.provider}-${g.model}-${g.operation}-${String(g.is_mock)}`}>
                <td className="td text-xs">
                  {g.provider} / {g.model} {g.is_mock ? <Badge tone="violet">mock</Badge> : null}
                </td>
                <td className="td text-xs">{g.operation.toLowerCase().replace(/_/g, " ")}</td>
                <td className="td tabular-nums">{num(Number(g.calls))}</td>
                <td className="td tabular-nums">{usd(decimalToMicros(g.cost))}</td>
              </tr>
            ))}
          </Table>
          {groups.length === 0 ? (
            <p className="text-sm text-zinc-500">No paid operations in this period.</p>
          ) : null}
        </Card>
        <Card title="Global (workspace) budget">
          <div className="space-y-3">
            <BudgetMeter
              label="Today"
              spent={spendWs.workspace.day}
              limit={limits.workspace?.dailyMicros ?? null}
              format={fmt}
            />
            <BudgetMeter
              label="This week"
              spent={spendWs.workspace.week}
              limit={limits.workspace?.weeklyMicros ?? null}
              format={fmt}
            />
            <BudgetMeter
              label="This month"
              spent={spendWs.workspace.month}
              limit={limits.workspace?.monthlyMicros ?? null}
              format={fmt}
            />
            <BudgetMeter
              label="Real money today (HARD_DAILY_BUDGET_USD)"
              spent={spendWs.systemRealDay}
              limit={usdToMicros(e.HARD_DAILY_BUDGET_USD)}
              format={fmt}
            />
          </div>
          {user.role === "OWNER" || user.role === "ADMIN" ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-semibold">Edit workspace budget</summary>
              <ActionForm
                action={updateBudgetAction}
                submitLabel="Save"
                className="mt-3 grid gap-3 sm:grid-cols-3"
              >
                <input type="hidden" name="scope" value="workspace" />
                {(
                  [
                    ["dailyLimitUsd", "Daily (USD)", wsBudget?.dailyLimitUsd],
                    ["weeklyLimitUsd", "Weekly (USD)", wsBudget?.weeklyLimitUsd],
                    ["monthlyLimitUsd", "Monthly (USD)", wsBudget?.monthlyLimitUsd],
                  ] as const
                ).map(([name, label, value]) => (
                  <label key={name} className="block">
                    <span className="label">{label}</span>
                    <input
                      name={name}
                      inputMode="decimal"
                      defaultValue={m(value)}
                      placeholder="no limit"
                      className="input"
                    />
                  </label>
                ))}
                <input type="hidden" name="maxContentCostUsd" value="" />
                <input type="hidden" name="maxAiVideoCostUsd" value="" />
                <input type="hidden" name="maxRegenerations" value="" />
                <label className="flex items-center gap-2 text-sm sm:col-span-3">
                  <input
                    type="checkbox"
                    name="isEnforced"
                    defaultChecked={wsBudget?.isEnforced ?? true}
                    className="size-4"
                  />{" "}
                  Enforce
                </label>
              </ActionForm>
            </details>
          ) : null}
        </Card>
        <Card title="Brand budgets">
          <div className="space-y-5">
            {brandBudgets.map(({ brand, limits: l, spend }) => (
              <div key={brand.id}>
                <h3 className="mb-2 text-sm font-semibold">
                  <a href={`/brands/${brand.id}`} className="hover:underline">
                    {brand.name}
                  </a>
                  <span className="ml-2 text-xs font-normal text-zinc-500">
                    max per content {l?.contentCapMicros ? usd(l.contentCapMicros) : "—"} · AI video{" "}
                    {l?.aiVideoCapMicros ? usd(l.aiVideoCapMicros) : "—"} · regenerations{" "}
                    {l?.maxRegenerations ?? "—"}
                  </span>
                </h3>
                <div className="grid gap-3 sm:grid-cols-3">
                  <BudgetMeter
                    label="Today"
                    spent={spend.brand.day}
                    limit={l?.dailyMicros ?? null}
                    format={fmt}
                  />
                  <BudgetMeter
                    label="Week"
                    spent={spend.brand.week}
                    limit={l?.weeklyMicros ?? null}
                    format={fmt}
                  />
                  <BudgetMeter
                    label="Month"
                    spent={spend.brand.month}
                    limit={l?.monthlyMicros ?? null}
                    format={fmt}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
