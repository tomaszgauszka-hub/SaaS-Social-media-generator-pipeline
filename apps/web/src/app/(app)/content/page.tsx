import type { Metadata } from "next";
import Link from "next/link";
import type { ContentStatus, Prisma } from "@cre/db";
import { decimalFieldToMicros } from "@cre/db";
import { EmptyState, FilterLink, PageHeader, StatusBadge, Table } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { date, usd } from "@/lib/format";

export const metadata: Metadata = { title: "Content" };

const GROUPS: Record<string, { label: string; statuses: ContentStatus[] }> = {
  all: { label: "All", statuses: [] },
  production: {
    label: "In production",
    statuses: ["IDEA", "RESEARCHING", "SCRIPTING", "ASSET_PLANNING", "GENERATING_ASSETS", "RENDERING", "QA"],
  },
  waiting: { label: "Waiting approval", statuses: ["WAITING_APPROVAL"] },
  scheduled: { label: "Approved / scheduled", statuses: ["APPROVED", "SCHEDULED", "PUBLISHING"] },
  published: { label: "Published", statuses: ["PUBLISHED", "ANALYTICS_PENDING", "ARCHIVED"] },
  problems: { label: "Rejected / failed / blocked", statuses: ["REJECTED", "FAILED", "BUDGET_BLOCKED"] },
};
const PAGE_SIZE = 25;

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string; brand?: string; q?: string; page?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const group = sp.group && sp.group in GROUPS ? sp.group : "all";
  const page = Math.max(1, Number(sp.page) || 1);
  const q = (sp.q ?? "").trim().slice(0, 100);
  const prisma = db();
  const brands = await prisma.brand.findMany({
    where: { workspaceId: user.workspaceId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const brandId = brands.some((b) => b.id === sp.brand) ? sp.brand : undefined;
  const statuses = GROUPS[group]!.statuses;
  const where: Prisma.ContentProjectWhereInput = {
    workspaceId: user.workspaceId,
    ...(brandId ? { brandId } : {}),
    ...(statuses.length ? { status: { in: statuses } } : {}),
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { hook: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [total, projects] = await Promise.all([
    prisma.contentProject.count({ where }),
    prisma.contentProject.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { brand: { select: { name: true } }, _count: { select: { variants: true } } },
    }),
  ]);
  const costs = projects.length
    ? await prisma.generationUsage.groupBy({
        by: ["projectId"],
        where: { projectId: { in: projects.map((p) => p.id) }, status: { in: ["COMMITTED", "RESERVED"] } },
        _sum: { estimatedCostUsd: true, actualCostUsd: true },
      })
    : [];
  const costOf = (id: string) => {
    const c = costs.find((x) => x.projectId === id)?._sum;
    return c ? decimalFieldToMicros(c.actualCostUsd ?? c.estimatedCostUsd) : 0;
  };
  const href = (over: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = { group, brand: brandId, q: q || undefined, ...over };
    for (const [k, v] of Object.entries(merged)) if (v && !(k === "group" && v === "all")) params.set(k, v);
    const s = params.toString();
    return s ? `/content?${s}` : "/content";
  };
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader
        title="Content"
        subtitle={`${total} item(s)`}
        actions={
          <Link href="/brands" className="btn-primary">
            Generate ideas
          </Link>
        }
      />
      <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
        {Object.entries(GROUPS).map(([key, g]) => (
          <FilterLink key={key} href={href({ group: key, page: undefined })} active={group === key}>
            {g.label}
          </FilterLink>
        ))}
      </div>
      <form className="mb-4 flex flex-wrap gap-2" action="/content">
        {group !== "all" ? <input type="hidden" name="group" value={group} /> : null}
        <select name="brand" defaultValue={brandId ?? ""} className="input w-auto" aria-label="Brand">
          <option value="">All brands</option>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <input
          name="q"
          defaultValue={q}
          placeholder="Search title or hook"
          className="input w-full sm:w-64"
          aria-label="Search"
        />
        <button type="submit" className="btn-secondary">
          Filter
        </button>
      </form>
      {projects.length === 0 ? (
        <EmptyState title="No content matches" />
      ) : (
        <div className="card">
          <Table
            head={
              <>
                <th className="th">Content</th>
                <th className="th">Status</th>
                <th className="th hidden sm:table-cell">QA</th>
                <th className="th hidden md:table-cell">Tier</th>
                <th className="th hidden md:table-cell">Cost</th>
                <th className="th hidden lg:table-cell">Updated</th>
              </>
            }
          >
            {projects.map((p) => (
              <tr key={p.id} className="hover:bg-zinc-50">
                <td className="td">
                  <Link href={`/content/${p.id}`} className="flex items-center gap-3">
                    {p.coverAssetId ? (
                      <img
                        src={`/api/assets/${p.coverAssetId}`}
                        alt=""
                        className="h-14 w-8 shrink-0 rounded object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="h-14 w-8 shrink-0 rounded bg-zinc-200" />
                    )}
                    <span className="min-w-0">
                      <span className="block font-semibold hover:underline">{p.title}</span>
                      <span className="block text-xs text-zinc-500">
                        {p.brand.name} · {p._count.variants} variant(s)
                      </span>
                    </span>
                  </Link>
                </td>
                <td className="td">
                  <StatusBadge status={p.status} />
                </td>
                <td className="td hidden tabular-nums sm:table-cell">{p.qaScore ?? "—"}</td>
                <td className="td hidden md:table-cell">{p.tier?.replace("_", " ") ?? "—"}</td>
                <td className="td hidden tabular-nums md:table-cell">{usd(costOf(p.id))}</td>
                <td className="td hidden text-zinc-500 lg:table-cell">{date(p.updatedAt, user.timezone)}</td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      {pages > 1 ? (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
          {page > 1 ? (
            <Link href={href({ page: String(page - 1) })} className="btn-secondary">
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="text-zinc-500">
            Page {page} / {pages}
          </span>
          {page < pages ? (
            <Link href={href({ page: String(page + 1) })} className="btn-secondary">
              Older →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </>
  );
}
