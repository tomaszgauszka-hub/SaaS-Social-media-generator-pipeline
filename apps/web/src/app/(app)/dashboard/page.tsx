import type { Metadata } from "next";
import Link from "next/link";
import { aiCostMicros, kpiSummary, profitability } from "@cre/core";
import { startOfPeriod } from "@cre/shared";
import { LineChart } from "@/components/charts";
import { Badge, Card, EmptyState, Kpi, PageHeader, SimulatedNote, StatusBadge } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { dateTime, num, pct, relative, usd } from "@/lib/format";
import { dayLabels, includeSimulated, periodFor } from "@/lib/period";

export const metadata: Metadata = { title: "Dashboard" };

const IN_FLIGHT = [
  "IDEA",
  "RESEARCHING",
  "SCRIPTING",
  "ASSET_PLANNING",
  "GENERATING_ASSETS",
  "RENDERING",
  "QA",
] as const;

export default async function DashboardPage() {
  const user = await requireUser();
  const tz = user.timezone;
  const now = new Date();
  const sim = includeSimulated();
  const p = periodFor("30d", tz, now);
  const ws = user.workspaceId;
  const monthStart = startOfPeriod(now, "month", tz);
  const prisma = db();
  const [
    kpis,
    costToday,
    costMonth,
    waiting,
    publishedToday,
    scheduled,
    failedJobs,
    blocked,
    inFlight,
    daily,
    queue,
    upcoming,
    failures,
  ] = await Promise.all([
    kpiSummary(prisma, { workspaceId: ws, from: p.from, to: p.to, includeSimulated: sim }),
    aiCostMicros(prisma, { workspaceId: ws, from: p.today, to: p.to, includeSimulated: true }),
    aiCostMicros(prisma, { workspaceId: ws, from: monthStart, to: p.to, includeSimulated: true }),
    prisma.contentProject.count({ where: { workspaceId: ws, status: "WAITING_APPROVAL" } }),
    prisma.publication.count({
      where: { workspaceId: ws, status: "PUBLISHED", publishedAt: { gte: p.today, lt: p.to } },
    }),
    prisma.publication.count({ where: { workspaceId: ws, status: "SCHEDULED" } }),
    prisma.generationJob.count({ where: { workspaceId: ws, status: { in: ["FAILED", "DEAD_LETTER"] } } }),
    prisma.contentProject.count({ where: { workspaceId: ws, status: "BUDGET_BLOCKED" } }),
    prisma.contentProject.groupBy({
      by: ["status"],
      where: { workspaceId: ws, status: { in: [...IN_FLIGHT] } },
      _count: { _all: true },
    }),
    profitability(prisma, {
      workspaceId: ws,
      from: p.from,
      to: p.to,
      includeSimulated: sim,
      dimension: "day",
      timeZone: tz,
    }),
    prisma.contentProject.findMany({
      where: { workspaceId: ws, status: "WAITING_APPROVAL" },
      orderBy: { statusChangedAt: "asc" },
      take: 4,
      include: { brand: { select: { name: true } } },
    }),
    prisma.publication.findMany({
      where: { workspaceId: ws, status: "SCHEDULED" },
      orderBy: { scheduledAt: "asc" },
      take: 5,
      include: {
        variant: { select: { project: { select: { id: true, title: true } } } },
        brand: { select: { name: true } },
      },
    }),
    prisma.generationJob.findMany({
      where: { workspaceId: ws, status: { in: ["FAILED", "DEAD_LETTER", "BUDGET_BLOCKED"] } },
      orderBy: { updatedAt: "desc" },
      take: 5,
    }),
  ]);
  const days = dayLabels(p.from, p.days, tz);
  const byDay = new Map(daily.map((d) => [d.key, d]));
  const profitTone = kpis.profitMicros > 0 ? "good" : kpis.profitMicros < 0 ? "bad" : "neutral";

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`Last 30 days · ${user.workspaceName}`}
        actions={
          <Link href="/approval" className="btn-primary">
            Review queue ({waiting})
          </Link>
        }
      />
      <SimulatedNote show={sim} />

      <section
        aria-label="Profit"
        className="card mb-4 flex flex-wrap items-end justify-between gap-4 px-5 py-4"
      >
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Profit · 30 days</div>
          <div
            className={`text-5xl font-bold ${profitTone === "good" ? "text-emerald-700" : profitTone === "bad" ? "text-rose-700" : ""}`}
          >
            {usd(kpis.profitMicros)}
          </div>
          <div className="mt-1 text-sm text-zinc-500">
            revenue {usd(kpis.revenueMicros)} − AI {usd(kpis.aiCostMicros)} − infrastructure{" "}
            {usd(kpis.infrastructureCostMicros)} − ads {usd(kpis.adCostMicros)}
          </div>
        </div>
        <div className="text-right text-sm text-zinc-600">
          <div>
            ROI <strong className="text-zinc-900">{pct(kpis.roi, 0)}</strong>
          </div>
          <div>
            RPM <strong className="text-zinc-900">{usd(kpis.rpmMicros)}</strong>
          </div>
        </div>
      </section>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi
          label="Awaiting approval"
          value={waiting}
          hint={
            <Link href="/approval" className="underline">
              open queue
            </Link>
          }
        />
        <Kpi label="Published today" value={publishedToday} />
        <Kpi
          label="Scheduled"
          value={scheduled}
          hint={
            <Link href="/calendar" className="underline">
              calendar
            </Link>
          }
        />
        <Kpi
          label="Failed jobs"
          value={failedJobs}
          tone={failedJobs ? "bad" : "neutral"}
          hint={blocked ? `${blocked} budget-blocked` : undefined}
        />
        <Kpi label="AI cost today" value={usd(costToday)} hint={`month ${usd(costMonth)}`} />
        <Kpi label="Clicks" value={num(kpis.clicks)} hint={`CTR ${pct(kpis.ctr, 2)}`} />
        <Kpi label="Conversions" value={num(kpis.conversions)} hint={`CVR ${pct(kpis.conversionRate)}`} />
        <Kpi label="Revenue" value={usd(kpis.revenueMicros)} />
        <Kpi label="Impressions" value={num(kpis.impressions)} />
        <Kpi
          label="Cost / published"
          value={usd(kpis.costPerPublishedMicros)}
          hint={`${kpis.publishedCount} posts`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Revenue vs. AI cost per day" className="lg:col-span-2">
          <LineChart
            title="Revenue and AI cost per day (USD)"
            labels={days.map((d) => d.label)}
            unit="usd"
            series={[
              {
                key: "revenue",
                label: "Revenue",
                values: days.map((d) => byDay.get(d.key)?.revenueMicros ?? 0),
              },
              { key: "cost", label: "AI cost", values: days.map((d) => byDay.get(d.key)?.aiCostMicros ?? 0) },
            ]}
          />
        </Card>
        <Card title="Pipeline">
          {inFlight.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing in production right now.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {IN_FLIGHT.map((s) => {
                const count = inFlight.find((x) => x.status === s)?._count._all ?? 0;
                return count ? (
                  <li key={s} className="flex items-center justify-between">
                    <StatusBadge status={s} />
                    <span className="font-semibold tabular-nums">{count}</span>
                  </li>
                ) : null;
              })}
            </ul>
          )}
          {blocked ? (
            <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">
              {blocked} content item(s) are BUDGET_BLOCKED — they resume automatically when budget is
              available.{" "}
              <Link href="/costs" className="underline">
                Budgets
              </Link>
            </p>
          ) : null}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card
          title="Waiting for you"
          actions={
            <Link href="/approval" className="text-xs font-semibold text-brand-700">
              All
            </Link>
          }
        >
          {queue.length === 0 ? (
            <EmptyState title="Queue is empty">New content appears here after automated QA.</EmptyState>
          ) : (
            <ul className="space-y-3">
              {queue.map((q) => (
                <li key={q.id}>
                  <Link
                    href={`/approval#${q.id}`}
                    className="flex items-center gap-3 rounded-lg p-1 hover:bg-zinc-50"
                  >
                    {q.coverAssetId ? (
                      <img
                        src={`/api/assets/${q.coverAssetId}`}
                        alt=""
                        className="h-16 w-9 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <div className="h-16 w-9 shrink-0 rounded bg-zinc-200" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{q.title}</div>
                      <div className="text-xs text-zinc-500">
                        {q.brand.name} · QA {q.qaScore ?? "—"} · {relative(q.statusChangedAt, now)}
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card
          title="Next publications"
          actions={
            <Link href="/calendar" className="text-xs font-semibold text-brand-700">
              Calendar
            </Link>
          }
        >
          {upcoming.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing scheduled.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {upcoming.map((u) => (
                <li key={u.id} className="flex items-start justify-between gap-2">
                  <Link
                    href={`/content/${u.variant.project.id}`}
                    className="min-w-0 truncate hover:underline"
                  >
                    {u.variant.project.title}
                  </Link>
                  <span className="shrink-0 text-xs text-zinc-500">
                    <Badge tone={u.isMock ? "violet" : "indigo"}>{u.platform.toLowerCase()}</Badge>{" "}
                    {dateTime(u.scheduledAt, tz)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card
          title="Needs attention"
          actions={
            <Link href="/jobs?status=FAILED" className="text-xs font-semibold text-brand-700">
              Jobs
            </Link>
          }
        >
          {failures.length === 0 ? (
            <p className="text-sm text-zinc-500">No failed or blocked jobs. ✓</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {failures.map((j) => (
                <li key={j.id}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">{j.type}</span>
                    <StatusBadge status={j.status} />
                  </div>
                  <p className="line-clamp-2 text-xs text-zinc-500">{j.lastError}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
