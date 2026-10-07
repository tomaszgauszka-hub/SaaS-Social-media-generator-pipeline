import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { latestPerPublication } from "@cre/analytics";
import { publicLinkUrl } from "@cre/core";
import { decimalFieldToMicros } from "@cre/db";
import { retryProjectAction, unapproveAction } from "@/app/actions/content";
import { ActionButton } from "@/components/action-button";
import { Badge, Card, Dl, PageHeader, StatusBadge, Table } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db, env } from "@/lib/db";
import { dateTime, num, pct, seconds, usd } from "@/lib/format";

export const metadata: Metadata = { title: "Content detail" };

interface QaReport {
  score?: number;
  issues?: { code: string; severity: string; message: string; platform?: string }[];
  llm?: { score: number; assessment: string } | null;
  media?: { durationMs: number; integratedLufs: number | null } | null;
}
interface RouterDecision {
  tier?: string;
  reasons?: string[];
  estimate?: { totalMicros: number };
  performance?: string;
}

const EVENT_TONE: Record<string, "gray" | "blue" | "green" | "red" | "amber" | "violet"> = {
  DISPATCH: "gray",
  START: "blue",
  SUCCESS: "green",
  FAILURE: "red",
  RETRY: "amber",
  COST: "violet",
  BUDGET_BLOCKED: "red",
  INFO: "gray",
  WARN: "amber",
};

export default async function ContentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const tz = user.timezone;
  const prisma = db();
  const project = await prisma.contentProject.findFirst({
    where: { id, workspaceId: user.workspaceId },
    include: {
      brand: { select: { id: true, name: true } },
      product: { select: { id: true, title: true } },
      idea: { include: { score: true } },
      template: { select: { key: true, version: true } },
      scriptPromptVersion: { select: { key: true, version: true } },
      scenes: { orderBy: { index: "asc" } },
      variants: {
        orderBy: { platform: "asc" },
        include: {
          trackedLink: { include: { _count: { select: { clicks: true } } } },
          publications: {
            include: {
              snapshots: { orderBy: { capturedAt: "desc" }, take: 1 },
              socialAccount: { select: { handle: true, isMock: true } },
            },
          },
        },
      },
      approvals: { orderBy: { createdAt: "desc" }, include: { user: { select: { email: true } } } },
      usages: { orderBy: { createdAt: "asc" } },
      jobs: { orderBy: { createdAt: "asc" }, include: { events: { orderBy: { createdAt: "asc" } } } },
      masterAsset: { include: { inputs: { include: { inputAsset: true } } } },
    },
  });
  if (!project) notFound();
  const report = (project.qaReport ?? {}) as QaReport;
  const decision = (project.routerDecision ?? {}) as RouterDecision;
  const spent = project.usages
    .filter((u) => u.status !== "RELEASED")
    .reduce((s, u) => s + decimalFieldToMicros(u.actualCostUsd ?? u.estimatedCostUsd), 0);
  const allPubs = project.variants.flatMap((v) => v.publications);
  const latest = latestPerPublication(allPubs.flatMap((p) => p.snapshots));
  const impressions = allPubs.reduce((s, p) => s + (latest.get(p.id)?.impressions ?? 0), 0);
  const clicks = project.variants.reduce((s, v) => s + (v.trackedLink?._count.clicks ?? 0), 0);
  const revenue = await prisma.revenueEntry.aggregate({
    where: { projectId: project.id },
    _sum: { amountUsd: true },
  });
  const revenueMicros = decimalFieldToMicros(revenue._sum.amountUsd);
  const score = project.idea?.score;
  const appUrl = env().APP_URL;
  const inputs = project.masterAsset?.inputs ?? [];

  return (
    <>
      <PageHeader
        title={project.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={project.status} />
            <Link href={`/brands/${project.brand.id}`} className="underline">
              {project.brand.name}
            </Link>
            {project.product ? <span>· {project.product.title}</span> : null}
            <span>· revision {project.revision}</span>
          </span>
        }
        actions={
          <>
            {project.status === "WAITING_APPROVAL" ? (
              <Link href={`/approval#${project.id}`} className="btn-primary">
                Review
              </Link>
            ) : null}
            {project.status === "FAILED" ? (
              <ActionButton
                action={retryProjectAction.bind(null, { projectId: project.id })}
                label="Retry failed step"
                className="btn-primary"
              />
            ) : null}
            {project.status === "APPROVED" || project.status === "SCHEDULED" ? (
              <ActionButton
                action={unapproveAction.bind(null, { projectId: project.id })}
                label="Withdraw approval"
                confirm="Cancel the scheduled posts and return this to the approval queue?"
              />
            ) : null}
          </>
        }
      />
      {project.failureReason ? (
        <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{project.failureReason}</p>
      ) : null}
      {project.status === "BUDGET_BLOCKED" ? (
        <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
          Blocked by budget before any paid call — resumes automatically at{" "}
          {project.resumeStatus?.toLowerCase().replace(/_/g, " ")} when budget is available.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_1fr]">
        <div className="space-y-4">
          <div className="overflow-hidden rounded-xl bg-black">
            {project.masterAssetId ? (
              <video
                className="aspect-[9/16] w-full object-contain"
                src={`/api/assets/${project.masterAssetId}`}
                poster={project.coverAssetId ? `/api/assets/${project.coverAssetId}` : undefined}
                controls
                playsInline
                preload="metadata"
              />
            ) : (
              <div className="flex aspect-[9/16] items-center justify-center text-sm text-zinc-400">
                Not rendered yet
              </div>
            )}
          </div>
          <Card title="Estimate vs. actual">
            <p className="mb-2 text-xs text-zinc-500">
              Estimates come from the opportunity score ({score?.model ?? "—"}) and are stored separately from
              real analytics.
            </p>
            <Table
              head={
                <>
                  <th className="th">Metric</th>
                  <th className="th">Estimated</th>
                  <th className="th">Actual</th>
                </>
              }
            >
              <tr>
                <td className="td">Impressions</td>
                <td className="td tabular-nums">{num(score?.expectedImpressions)}</td>
                <td className="td tabular-nums">{num(impressions)}</td>
              </tr>
              <tr>
                <td className="td">CTR</td>
                <td className="td tabular-nums">{pct(score?.expectedCtr, 2)}</td>
                <td className="td tabular-nums">{impressions ? pct(clicks / impressions, 2) : "—"}</td>
              </tr>
              <tr>
                <td className="td">Revenue</td>
                <td className="td tabular-nums">
                  {score ? usd(decimalFieldToMicros(score.estimatedRevenueUsd)) : "—"}
                </td>
                <td className="td tabular-nums">{usd(revenueMicros)}</td>
              </tr>
              <tr>
                <td className="td">Cost</td>
                <td className="td tabular-nums">
                  {project.costEstimateUsd ? usd(decimalFieldToMicros(project.costEstimateUsd)) : "—"}
                </td>
                <td className="td tabular-nums">{usd(spent)}</td>
              </tr>
              <tr>
                <td className="td font-semibold">Profit</td>
                <td className="td tabular-nums">
                  {score ? usd(decimalFieldToMicros(score.expectedProfitUsd)) : "—"}
                </td>
                <td
                  className={`td font-semibold tabular-nums ${revenueMicros - spent >= 0 ? "text-emerald-700" : "text-rose-700"}`}
                >
                  {usd(revenueMicros - spent)}
                </td>
              </tr>
            </Table>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card title="Creative">
            <Dl
              items={[
                ["Hook", project.hook?.replace(/\*/g, "") ?? "—"],
                ["Hook style / angle", `${project.hookStyle ?? "—"} · ${project.angle ?? "—"}`],
                ["CTA", `${project.cta ?? "—"} (${project.ctaType ?? "—"})`],
                ["Duration", seconds(project.durationMs)],
                ["Template", project.template ? `${project.template.key} v${project.template.version}` : "—"],
                [
                  "Script prompt",
                  project.scriptPromptVersion
                    ? `${project.scriptPromptVersion.key} v${project.scriptPromptVersion.version}`
                    : "—",
                ],
                [
                  "Tier",
                  project.tier
                    ? `${project.tier.replace("_", " ")} — ${decision.reasons?.join("; ") ?? ""}`
                    : "—",
                ],
                ["AI-generated visuals", project.aiGenerated ? "yes (platform AI label + disclosure)" : "no"],
                ["Commercial intent", project.commercialIntent ?? "—"],
              ]}
            />
          </Card>

          <Card title={`Automated QA · ${project.qaScore ?? "—"}/100`}>
            {report.llm ? (
              <p className="mb-2 text-sm text-zinc-600">
                LLM review ({report.llm.score}/100): {report.llm.assessment}
              </p>
            ) : null}
            {report.issues?.length ? (
              <ul className="space-y-1 text-sm">
                {report.issues.map((i, k) => (
                  <li key={k} className="flex gap-2">
                    <Badge
                      tone={i.severity === "blocker" ? "red" : i.severity === "major" ? "amber" : "gray"}
                    >
                      {i.severity}
                    </Badge>
                    <span>
                      {i.platform ? `[${i.platform}] ` : ""}
                      {i.message}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500">
                {project.qaReport ? "No findings." : "QA has not run yet."}
              </p>
            )}
          </Card>

          <Card title="Platform variants & publications">
            <div className="space-y-4">
              {project.variants.map((v) => (
                <div key={v.id} className="rounded-lg border border-zinc-200 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm">{v.platform}</strong>
                    <StatusBadge status={v.status} />
                    {v.qaScore !== null ? <Badge>QA {v.qaScore}</Badge> : null}
                    {v.trackedLink ? (
                      <span className="text-xs text-zinc-500">
                        link <code>{publicLinkUrl(appUrl, v.trackedLink)}</code> ·{" "}
                        {v.trackedLink._count.clicks} clicks
                        {v.trackedLink.redirect ? "" : " (direct link — network-side attribution)"}
                      </span>
                    ) : null}
                  </div>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-zinc-500">Caption</summary>
                    <p className="mt-1 text-sm whitespace-pre-wrap">{v.caption}</p>
                  </details>
                  {v.publications.map((p) => {
                    const snap = latest.get(p.id);
                    return (
                      <div
                        key={p.id}
                        className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-600"
                      >
                        <StatusBadge status={p.status} />
                        <span>
                          {p.socialAccount.handle}
                          {p.isMock ? " (mock)" : ""}
                        </span>
                        <span>
                          {p.publishedAt
                            ? `published ${dateTime(p.publishedAt, tz)}`
                            : `scheduled ${dateTime(p.scheduledAt, tz)}`}
                        </span>
                        {snap ? (
                          <span className="tabular-nums">
                            {num(snap.impressions)} impressions · {num(snap.likes)} likes ·{" "}
                            {pct(snap.completionRate)} completion
                          </span>
                        ) : null}
                        {p.externalUrl ? (
                          <a
                            href={p.externalUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="underline"
                          >
                            post
                          </a>
                        ) : null}
                        {p.lastError ? <span className="text-rose-700">{p.lastError}</span> : null}
                      </div>
                    );
                  })}
                </div>
              ))}
              {project.variants.length === 0 ? (
                <p className="text-sm text-zinc-500">Variants are created after rendering.</p>
              ) : null}
            </div>
          </Card>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Scenes">
          <Table
            head={
              <>
                <th className="th">#</th>
                <th className="th">Kind</th>
                <th className="th">On screen</th>
                <th className="th">Visual</th>
              </>
            }
          >
            {project.scenes.map((s) => (
              <tr key={s.id}>
                <td className="td tabular-nums">{s.index + 1}</td>
                <td className="td">
                  {s.kind.toLowerCase()}
                  <div className="text-xs text-zinc-500">{seconds(s.durationMs)}</div>
                </td>
                <td className="td">{s.onScreenText?.replace(/\*/g, "") ?? "—"}</td>
                <td className="td text-xs text-zinc-600">
                  {s.visualType} {s.revision > 1 ? `(rev ${s.revision})` : ""}
                  {s.primaryAssetId ? (
                    <img
                      src={`/api/assets/${s.primaryAssetId}`}
                      alt=""
                      className="mt-1 h-16 w-9 rounded object-cover"
                      loading="lazy"
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="Asset provenance (current video)">
          {inputs.length === 0 ? (
            <p className="text-sm text-zinc-500">No rendered video yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {inputs.map((i) => (
                <li key={`${i.inputAssetId}-${i.role}`} className="rounded-lg border border-zinc-100 p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="indigo">{i.role}</Badge>
                    <span className="font-semibold">{i.inputAsset.kind.toLowerCase()}</span>
                    <span className="text-xs text-zinc-500">
                      {i.inputAsset.provider}/{i.inputAsset.model} · {i.inputAsset.origin.toLowerCase()}
                      {i.inputAsset.isMock ? " · mock" : ""}
                    </span>
                    <span className="ml-auto text-xs tabular-nums">
                      {i.inputAsset.generationCostUsd
                        ? usd(decimalFieldToMicros(i.inputAsset.generationCostUsd))
                        : "free"}
                    </span>
                  </div>
                  {i.inputAsset.prompt ? (
                    <p className="mt-1 line-clamp-2 text-xs text-zinc-500">prompt: {i.inputAsset.prompt}</p>
                  ) : null}
                  <p className="text-xs text-zinc-500">
                    license: {i.inputAsset.license ?? "—"} · created {dateTime(i.inputAsset.createdAt, tz)}
                    {i.inputAsset.sourceUrl ? ` · source ${i.inputAsset.sourceUrl}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={`Generation costs · ${usd(spent)}`}>
          <Table
            head={
              <>
                <th className="th">Operation</th>
                <th className="th">Provider / model</th>
                <th className="th">Units</th>
                <th className="th">Cost</th>
              </>
            }
          >
            {project.usages.map((u) => (
              <tr key={u.id} className={u.status === "RELEASED" ? "opacity-50" : ""}>
                <td className="td">
                  {u.operation.toLowerCase().replace(/_/g, " ")}
                  <div className="text-xs text-zinc-500">{u.status.toLowerCase()}</div>
                </td>
                <td className="td text-xs">
                  {u.provider} / {u.model}
                  {u.isMock ? <Badge tone="violet">mock</Badge> : null}
                </td>
                <td className="td text-xs tabular-nums">
                  {u.inputTokens || u.outputTokens
                    ? `${u.inputTokens}→${u.outputTokens} tok`
                    : u.imageCount
                      ? `${u.imageCount} img`
                      : u.videoSeconds
                        ? `${u.videoSeconds}s video`
                        : u.characters
                          ? `${u.characters} chars`
                          : "—"}
                </td>
                <td className="td tabular-nums">
                  {usd(decimalFieldToMicros(u.actualCostUsd ?? u.estimatedCostUsd))}
                </td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="Job timeline">
          <ol className="space-y-3">
            {project.jobs.map((j) => (
              <li key={j.id} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{j.type}</span>
                  <StatusBadge status={j.status} />
                  <span className="text-xs text-zinc-500">
                    attempt {j.attempts}/{j.maxAttempts}
                  </span>
                </div>
                <ul className="mt-1 space-y-0.5 border-l border-zinc-200 pl-3">
                  {j.events.map((e) => (
                    <li key={e.id} className="flex gap-2 text-xs">
                      <span className="shrink-0 text-zinc-400 tabular-nums">{dateTime(e.createdAt, tz)}</span>
                      <Badge tone={EVENT_TONE[e.type] ?? "gray"}>{e.type}</Badge>
                      <span className="min-w-0 break-words text-zinc-600">{e.message}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </Card>

        <Card title="Decisions">
          {project.approvals.length === 0 ? (
            <p className="text-sm text-zinc-500">No decisions yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {project.approvals.map((a) => (
                <li key={a.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge
                      status={
                        a.decision === "AUTO_REJECTED"
                          ? "REJECTED"
                          : a.decision === "APPROVED"
                            ? "SUCCEEDED"
                            : "PENDING"
                      }
                    />
                    <strong>{a.decision.toLowerCase().replace(/_/g, " ")}</strong>
                    {a.scope ? <Badge>{a.scope.toLowerCase()}</Badge> : null}
                    {a.reasons.map((r) => (
                      <Badge key={r} tone="red">
                        {r.toLowerCase().replace(/_/g, " ")}
                      </Badge>
                    ))}
                    <span className="text-xs text-zinc-500">
                      rev {a.revision} · {a.user?.email ?? "system"} · {dateTime(a.createdAt, tz)}
                    </span>
                  </div>
                  {a.note ? <p className="mt-1 text-xs whitespace-pre-wrap text-zinc-600">{a.note}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
