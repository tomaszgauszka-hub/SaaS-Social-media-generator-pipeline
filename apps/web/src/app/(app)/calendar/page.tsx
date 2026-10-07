import type { Metadata } from "next";
import Link from "next/link";
import { addDays, startOfPeriod } from "@cre/shared";
import { Badge, EmptyState, FilterLink, PageHeader, StatusBadge } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Calendar" };

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const user = await requireUser();
  const tz = user.timezone;
  const offset = Math.max(-52, Math.min(52, Number((await searchParams).week) || 0));
  const start = addDays(startOfPeriod(new Date(), "day", tz), offset * 7 - 1);
  const end = addDays(start, 15);
  const pubs = await db().publication.findMany({
    where: {
      workspaceId: user.workspaceId,
      OR: [{ scheduledAt: { gte: start, lt: end } }, { publishedAt: { gte: start, lt: end } }],
      status: { not: "CANCELLED" },
    },
    orderBy: { scheduledAt: "asc" },
    include: {
      brand: { select: { name: true } },
      variant: { select: { project: { select: { id: true, title: true, coverAssetId: true } } } },
    },
  });
  const dayKey = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  const days: { key: string; label: string }[] = [];
  for (let i = 0; i < 15; i++) {
    const d = addDays(start, i);
    days.push({
      key: dayKey(d),
      label: new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        weekday: "short",
        day: "numeric",
        month: "short",
      }).format(d),
    });
  }
  const today = dayKey(new Date());
  const time = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d);

  return (
    <>
      <PageHeader
        title="Publishing calendar"
        subtitle={`Times in ${tz}. Approved content is placed into each brand's posting slots automatically.`}
      />
      <div className="mb-4 flex gap-2">
        <FilterLink href={`/calendar?week=${offset - 1}`} active={false}>
          ← Earlier
        </FilterLink>
        <FilterLink href="/calendar" active={offset === 0}>
          Now
        </FilterLink>
        <FilterLink href={`/calendar?week=${offset + 1}`} active={false}>
          Later →
        </FilterLink>
      </div>
      {pubs.length === 0 ? (
        <EmptyState title="Nothing scheduled in this period">
          Approve content in the queue to fill the calendar.
        </EmptyState>
      ) : null}
      <div className="space-y-3">
        {days.map((d) => {
          const items = pubs.filter((p) => dayKey(p.publishedAt ?? p.scheduledAt) === d.key);
          if (items.length === 0) return null;
          return (
            <section key={d.key} className="card p-3">
              <h2 className={`mb-2 text-sm font-semibold ${d.key === today ? "text-brand-700" : ""}`}>
                {d.label}
                {d.key === today ? " · today" : ""}
              </h2>
              <ul className="divide-y divide-zinc-100">
                {items.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 py-2">
                    <span className="w-12 shrink-0 text-sm font-semibold tabular-nums">
                      {time(p.publishedAt ?? p.scheduledAt)}
                    </span>
                    {p.variant.project.coverAssetId ? (
                      <img
                        src={`/api/assets/${p.variant.project.coverAssetId}`}
                        alt=""
                        className="h-12 w-7 shrink-0 rounded object-cover"
                        loading="lazy"
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/content/${p.variant.project.id}`}
                        className="block truncate text-sm font-medium hover:underline"
                      >
                        {p.variant.project.title}
                      </Link>
                      <span className="text-xs text-zinc-500">{p.brand.name}</span>
                    </div>
                    <Badge tone={p.isMock ? "violet" : "indigo"}>{p.platform.toLowerCase()}</Badge>
                    <StatusBadge status={p.status} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}
