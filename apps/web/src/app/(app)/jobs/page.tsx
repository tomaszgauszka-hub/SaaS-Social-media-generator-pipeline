import type { Metadata } from "next";
import Link from "next/link";
import type { JobStatus, Prisma } from "@cre/db";
import { retryJobAction } from "@/app/actions/jobs";
import { ActionButton } from "@/components/action-button";
import { Badge, EmptyState, FilterLink, PageHeader, StatusBadge } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { dateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Jobs" };

const FILTERS: Record<string, { label: string; statuses: JobStatus[] }> = {
  active: { label: "Active", statuses: ["QUEUED", "DISPATCHED", "RUNNING", "RETRYING"] },
  FAILED: { label: "Failed / dead letter", statuses: ["FAILED", "DEAD_LETTER"] },
  BUDGET_BLOCKED: { label: "Budget blocked", statuses: ["BUDGET_BLOCKED"] },
  SUCCEEDED: { label: "Succeeded", statuses: ["SUCCEEDED"] },
  all: { label: "All", statuses: [] },
};
const RETRYABLE = new Set(["FAILED", "DEAD_LETTER", "BUDGET_BLOCKED", "CANCELLED"]);

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const filter = sp.status && sp.status in FILTERS ? sp.status : "active";
  const statuses = FILTERS[filter]!.statuses;
  const where: Prisma.GenerationJobWhereInput = {
    workspaceId: user.workspaceId,
    ...(statuses.length ? { status: { in: statuses } } : {}),
  };
  const prisma = db();
  const [jobs, counts] = await Promise.all([
    prisma.generationJob.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: {
        events: { orderBy: { createdAt: "asc" }, take: 30 },
        project: { select: { id: true, title: true } },
      },
    }),
    prisma.generationJob.groupBy({
      by: ["status"],
      where: { workspaceId: user.workspaceId },
      _count: { _all: true },
    }),
  ]);
  const count = (s: JobStatus[]) =>
    counts.filter((c) => s.length === 0 || s.includes(c.status)).reduce((a, c) => a + c._count._all, 0);

  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle="Every pipeline step is a job: retried with backoff, dead-lettered when it keeps failing, parked when a budget would be exceeded."
      />
      <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
        {Object.entries(FILTERS).map(([key, f]) => (
          <FilterLink key={key} href={`/jobs?status=${key}`} active={filter === key}>
            {f.label} ({count(f.statuses)})
          </FilterLink>
        ))}
      </div>
      {jobs.length === 0 ? (
        <EmptyState title="No jobs here" />
      ) : (
        <ul className="space-y-2">
          {jobs.map((j) => (
            <li key={j.id} className="card p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm">{j.type}</span>
                <StatusBadge status={j.status} />
                <Badge>{j.queue}</Badge>
                <span className="text-xs text-zinc-500">
                  attempt {j.attempts}/{j.maxAttempts} · run at {dateTime(j.runAt, user.timezone)} · updated{" "}
                  {dateTime(j.updatedAt, user.timezone)}
                </span>
                {RETRYABLE.has(j.status) ? (
                  <span className="ml-auto">
                    <ActionButton
                      action={retryJobAction.bind(null, { jobId: j.id })}
                      label="Retry"
                      className="btn-secondary min-h-8 px-3 text-xs"
                    />
                  </span>
                ) : null}
              </div>
              {j.project ? (
                <Link
                  href={`/content/${j.project.id}`}
                  className="mt-1 block text-xs text-brand-700 hover:underline"
                >
                  {j.project.title}
                </Link>
              ) : null}
              {j.lastError ? <p className="mt-1 text-xs break-words text-rose-700">{j.lastError}</p> : null}
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-zinc-500">
                  Timeline ({j.events.length})
                </summary>
                <ul className="mt-1 space-y-0.5 border-l border-zinc-200 pl-3">
                  {j.events.map((e) => (
                    <li key={e.id} className="flex gap-2 text-xs">
                      <span className="shrink-0 text-zinc-400 tabular-nums">
                        {dateTime(e.createdAt, user.timezone)}
                      </span>
                      <span className="font-semibold">{e.type}</span>
                      <span className="min-w-0 break-words text-zinc-600">{e.message}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
