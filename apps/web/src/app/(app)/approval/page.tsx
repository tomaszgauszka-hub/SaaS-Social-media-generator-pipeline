import type { Metadata } from "next";
import { publicLinkUrl } from "@cre/core";
import { decimalFieldToMicros } from "@cre/db";
import { ApprovalCard, type ApprovalItem } from "@/components/approval-card";
import { EmptyState, FilterLink, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db, env } from "@/lib/db";
import { seconds, usd } from "@/lib/format";

export const metadata: Metadata = { title: "Approval queue" };

interface QaReport {
  issues?: { severity: string; message: string; platform?: string }[];
}
interface RouterDecision {
  reasons?: string[];
}

export default async function ApprovalPage({ searchParams }: { searchParams: Promise<{ brand?: string }> }) {
  const user = await requireUser();
  const { brand } = await searchParams;
  const prisma = db();
  const brands = await prisma.brand.findMany({
    where: { workspaceId: user.workspaceId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const brandId = brands.some((b) => b.id === brand) ? brand : undefined;
  const projects = await prisma.contentProject.findMany({
    where: { workspaceId: user.workspaceId, status: "WAITING_APPROVAL", ...(brandId ? { brandId } : {}) },
    orderBy: { statusChangedAt: "asc" },
    take: 30,
    include: {
      brand: { select: { name: true } },
      product: { select: { title: true } },
      variants: {
        where: { status: "READY" },
        include: { trackedLink: true, media: { where: { role: "VIDEO" }, select: { assetId: true } } },
        orderBy: [{ platform: "asc" }, { armKey: "asc" }],
      },
      scenes: {
        orderBy: { index: "asc" },
        select: { id: true, index: true, kind: true, onScreenText: true, visualType: true },
      },
    },
  });
  const costs = projects.length
    ? await prisma.generationUsage.groupBy({
        by: ["projectId"],
        where: { projectId: { in: projects.map((p) => p.id) }, status: { in: ["COMMITTED", "RESERVED"] } },
        _sum: { estimatedCostUsd: true, actualCostUsd: true },
      })
    : [];
  const appUrl = env().APP_URL;
  const items: ApprovalItem[] = projects.map((p) => {
    const report = (p.qaReport ?? {}) as QaReport;
    const decision = (p.routerDecision ?? {}) as RouterDecision;
    const cost = costs.find((c) => c.projectId === p.id)?._sum;
    return {
      id: p.id,
      title: p.title,
      brandName: p.brand.name,
      productTitle: p.product?.title ?? null,
      hook: p.hook ?? "",
      cta: p.cta ?? "",
      qaScore: p.qaScore,
      qaFindings: (report.issues ?? []).filter((i) => i.severity !== "info").slice(0, 6),
      tier: p.tier,
      tierReason: decision.reasons?.at(-1) ?? null,
      costUsd: usd(cost ? decimalFieldToMicros(cost.actualCostUsd ?? cost.estimatedCostUsd) : 0),
      duration: seconds(p.durationMs),
      videoAssetId: p.masterAssetId,
      coverAssetId: p.coverAssetId,
      aiGenerated: p.aiGenerated,
      regenerationCount: p.regenerationCount,
      scenes: p.scenes.map((s) => ({
        id: s.id,
        label: `Scene ${s.index + 1} · ${s.kind.toLowerCase()} · ${(s.onScreenText ?? s.visualType).replace(/\*/g, "").slice(0, 40)}`,
      })),
      variants: p.variants.map((v) => ({
        id: v.id,
        platform: v.platform,
        armKey: v.armKey,
        armHook: (v.overrides as { hook?: string } | null)?.hook ?? null,
        videoAssetId: v.media[0]?.assetId ?? null,
        caption: v.caption ?? "",
        disclosure: v.disclosureText,
        link: v.trackedLink ? publicLinkUrl(appUrl, v.trackedLink) : null,
        firstComment: v.firstComment,
      })),
    };
  });

  return (
    <>
      <PageHeader
        title="Approval queue"
        subtitle="Everything here passed automated QA. Approve, reject or regenerate — scheduling and publishing are automatic."
      />
      {brands.length > 1 ? (
        <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
          <FilterLink href="/approval" active={!brandId}>
            All brands
          </FilterLink>
          {brands.map((b) => (
            <FilterLink key={b.id} href={`/approval?brand=${b.id}`} active={brandId === b.id}>
              {b.name}
            </FilterLink>
          ))}
        </div>
      ) : null}
      {items.length === 0 ? (
        <EmptyState title="Nothing to review">
          New content lands here after research, script, assets, render and QA. Start ideation from a brand
          page.
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {items.map((item) => (
            <ApprovalCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </>
  );
}
