import type { Metadata } from "next";
import Link from "next/link";
import { aiCostMicros } from "@cre/core";
import { startOfPeriod } from "@cre/shared";
import { createBrandAction, requestIdeasAction } from "@/app/actions/brands";
import { ActionForm } from "@/components/action-form";
import { BrandFields } from "@/components/brand-form";
import { Badge, Card, PageHeader, StatusBadge } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { usd } from "@/lib/format";

export const metadata: Metadata = { title: "Brands" };

export default async function BrandsPage() {
  const user = await requireUser();
  const prisma = db();
  const now = new Date();
  const brands = await prisma.brand.findMany({
    where: { workspaceId: user.workspaceId },
    orderBy: { name: "asc" },
    include: {
      _count: { select: { products: true, projects: true } },
      socialAccounts: { select: { platform: true, status: true, isMock: true } },
    },
  });
  const spend = await Promise.all(
    brands.map((b) =>
      aiCostMicros(prisma, {
        workspaceId: user.workspaceId,
        brandId: b.id,
        from: startOfPeriod(now, "month", b.timezone),
        to: new Date(now.getTime() + 86_400_000),
        includeSimulated: true,
      }),
    ),
  );
  return (
    <>
      <PageHeader
        title="Brands"
        subtitle="Each brand has its own voice, products, budgets, disclosure rules, accounts and posting slots."
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {brands.map((b, i) => (
          <Card
            key={b.id}
            title={
              <Link href={`/brands/${b.id}`} className="hover:underline">
                {b.name}
              </Link>
            }
            actions={<StatusBadge status={b.status} />}
          >
            <p className="text-sm text-zinc-600">{b.niche}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {b.targetPlatforms.map((p) => (
                <Badge
                  key={p}
                  tone={
                    b.socialAccounts.some((a) => a.platform === p && !a.isMock && a.status === "CONNECTED")
                      ? "green"
                      : "violet"
                  }
                >
                  {p.toLowerCase()}
                </Badge>
              ))}
              <Badge tone="indigo">≤ {b.maxTier.replace("_", " ")}</Badge>
              {b.ttsEnabled ? <Badge>voice-over</Badge> : null}
              {b.autoIdeationEnabled ? <Badge tone="green">auto ideation</Badge> : null}
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              {b._count.products} products · {b._count.projects} content · AI spend this month{" "}
              {usd(spend[i] ?? 0)}
            </p>
            <ActionForm
              action={requestIdeasAction}
              submitLabel="Generate ideas"
              className="mt-3 flex flex-wrap items-end gap-2"
            >
              <input type="hidden" name="brandId" value={b.id} />
              <label className="text-xs">
                <span className="label">Count</span>
                <select name="count" defaultValue="1" className="input w-20">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs">
                <span className="label">Quality</span>
                <select name="quality" defaultValue="STANDARD" className="input w-32">
                  <option value="DRAFT">Draft</option>
                  <option value="STANDARD">Standard</option>
                  <option value="PREMIUM">Premium</option>
                </select>
              </label>
            </ActionForm>
          </Card>
        ))}
      </div>
      {user.role === "OWNER" || user.role === "ADMIN" ? (
        <details className="card mt-6 p-4">
          <summary className="cursor-pointer font-semibold">+ New brand</summary>
          <div className="mt-4">
            <ActionForm action={createBrandAction} submitLabel="Create brand">
              <BrandFields />
            </ActionForm>
          </div>
        </details>
      ) : null}
    </>
  );
}
