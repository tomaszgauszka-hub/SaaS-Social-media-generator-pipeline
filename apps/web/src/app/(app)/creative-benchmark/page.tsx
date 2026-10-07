import type { Metadata } from "next";
import type { CreativeQaReport, QualityVerdict, TechnicalQaReport } from "@cre/creative";
import { Badge, Card, EmptyState, Kpi, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { dateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Creative benchmark" };

/**
 * Creative Engine V2 checkpoint (spec §76): the six DEMO_ONLY benchmark reels rendered locally, with every
 * quality layer. Demo media — never production ready, never published.
 */
const STATUS_TONE = { pass: "green", warn: "amber", fail: "red" } as const;

function scoreTone(score: number): "green" | "amber" | "red" {
  return score >= 80 ? "green" : score >= 60 ? "amber" : "red";
}

export default async function CreativeBenchmarkPage() {
  const user = await requireUser();
  const renders = await db().creativeRender.findMany({
    where: { workspaceId: user.workspaceId, benchmark: true },
    orderBy: { createdAt: "desc" },
    distinct: ["storyboardId"],
    take: 12,
    include: { qualityScores: true },
  });
  const reels = renders.sort((a, b) => a.storyboardId.localeCompare(b.storyboardId));
  const tokens = reels.reduce((a, r) => a + r.aiTokens, 0);
  const external = reels.reduce(
    (a, r) => a + Number(r.externalCostUsd.toString()) + Number(r.aiCostUsd.toString()),
    0,
  );
  const avgRender = reels.length ? reels.reduce((a, r) => a + r.renderMs, 0) / reels.length / 1000 : 0;
  const creativeScores = reels.map((r) => r.qualityScores.find((q) => q.kind === "CREATIVE")?.score ?? 0);
  const avgCreative = creativeScores.length
    ? creativeScores.reduce((a, s) => a + s, 0) / creativeScores.length
    : 0;

  return (
    <>
      <PageHeader
        title="Creative benchmark"
        subtitle="Six demo products rendered by the local Creative Engine V2 — deterministic director, Remotion motion, synthesised audio, FFmpeg finishing — then checked by technical, creative, factual, compliance and localization QA. Demo media only: nothing here is production ready or published."
      />
      <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
        <strong>NOT PRODUCTION READY.</strong> These reels use vector demo illustrations of fictional products
        (labelled on screen), no affiliate links and no real offers. Scores mean “no known structural or
        technical defects”; creative quality still needs your visual review, and commercial success needs real
        revenue data.
      </div>
      {reels.length === 0 ? (
        <EmptyState title="No benchmark renders yet">
          Run <code className="font-mono">pnpm creative:benchmark</code> on the worker host — it renders the
          six reels locally (no AI calls, no paid services) and stores them here.
        </EmptyState>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Reels" value={reels.length} hint="one per category" />
            <Kpi
              label="AI tokens"
              value={tokens}
              hint="for directing and rendering"
              tone={tokens === 0 ? "good" : "bad"}
            />
            <Kpi
              label="External cost"
              value={`$${external.toFixed(2)}`}
              hint="image / video generation"
              tone={external === 0 ? "good" : "bad"}
            />
            <Kpi
              label="Avg render"
              value={`${avgRender.toFixed(0)} s`}
              hint={`avg creative score ${avgCreative.toFixed(0)}`}
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {reels.map((r) => {
              const tech = r.technicalReport as unknown as TechnicalQaReport;
              const verdict = r.verdict as unknown as QualityVerdict;
              const creative = r.qualityScores.find((q) => q.kind === "CREATIVE");
              const creativeReport = creative?.report as unknown as CreativeQaReport | undefined;
              const score = (kind: string) => r.qualityScores.find((q) => q.kind === kind);
              const warnings = tech.checks.filter((c) => c.status !== "pass");
              return (
                <Card
                  key={r.id}
                  title={r.title}
                  actions={
                    <Badge tone="red">
                      {r.productionReady ? "production ready" : "not production ready"}
                    </Badge>
                  }
                >
                  <div className="flex flex-col gap-4 sm:flex-row">
                    <div className="w-full shrink-0 sm:w-48">
                      {r.videoAssetId ? (
                        <video
                          className="aspect-[9/16] w-full rounded-lg bg-zinc-900 object-cover"
                          src={`/api/assets/${r.videoAssetId}`}
                          poster={r.posterAssetId ? `/api/assets/${r.posterAssetId}` : undefined}
                          controls
                          playsInline
                          preload="metadata"
                        />
                      ) : (
                        <div className="flex aspect-[9/16] items-center justify-center rounded-lg bg-zinc-100 text-xs text-zinc-500">
                          no video
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1 space-y-3 text-sm">
                      <div className="flex flex-wrap gap-1.5">
                        <Badge tone="violet">{r.category}</Badge>
                        <Badge>{r.structure.replace(/_/g, " ").toLowerCase()}</Badge>
                        <Badge>kit: {r.styleKit}</Badge>
                        {r.placeholderMedia ? <Badge tone="amber">demo media</Badge> : null}
                      </div>
                      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                        <dt className="text-zinc-500">Duration</dt>
                        <dd className="tabular-nums">{(r.durationMs / 1000).toFixed(1)} s</dd>
                        <dt className="text-zinc-500">Visual beats</dt>
                        <dd className="tabular-nums">{r.beatCount}</dd>
                        <dt className="text-zinc-500">Technical QA</dt>
                        <dd>
                          <Badge tone={r.technicalStatus === "PASS" ? "green" : "red"}>
                            {r.technicalStatus}
                          </Badge>
                          {warnings.length ? (
                            <span className="ml-1 text-amber-700">{warnings.length} warning(s)</span>
                          ) : null}
                        </dd>
                        <dt className="text-zinc-500">Creative QA</dt>
                        <dd>
                          <Badge tone={scoreTone(creative?.score ?? 0)}>{creative?.score ?? "—"}/100</Badge>
                        </dd>
                        <dt className="text-zinc-500">Factual · Compliance · L10n</dt>
                        <dd className="tabular-nums">
                          {score("FACTUAL")?.score ?? "—"} · {score("COMPLIANCE")?.passed ? "pass" : "fail"} ·{" "}
                          {score("LOCALIZATION")?.score ?? "—"}
                        </dd>
                        <dt className="text-zinc-500">Render time</dt>
                        <dd className="tabular-nums">
                          {(r.renderMs / 1000).toFixed(0)} s · {r.renderFps.toFixed(1)} fps
                        </dd>
                        <dt className="text-zinc-500">Audio + finishing + QA</dt>
                        <dd className="tabular-nums">
                          {((r.audioMs + r.finishMs) / 1000).toFixed(1)} s + {(r.qaMs / 1000).toFixed(1)} s
                        </dd>
                        <dt className="text-zinc-500">AI tokens · external cost</dt>
                        <dd className="tabular-nums">
                          {r.aiTokens} · ${Number(r.externalCostUsd.toString()).toFixed(2)}
                        </dd>
                        <dt className="text-zinc-500">Loudness</dt>
                        <dd className="tabular-nums">
                          {tech.metrics.integratedLufs?.toFixed(1) ?? "—"} LUFS ·{" "}
                          {tech.metrics.truePeakDb?.toFixed(1) ?? "—"} dBTP
                        </dd>
                      </dl>
                      <p className="text-xs text-zinc-500">
                        {r.rendererVersion} · {r.directorVersion} · {dateTime(r.createdAt, user.timezone)}
                      </p>
                    </div>
                  </div>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-semibold text-zinc-600">
                      Quality gates
                    </summary>
                    <ul className="mt-2 space-y-1 text-xs">
                      {verdict.gates.map((g) => (
                        <li key={g.gate} className="flex items-center gap-2">
                          <Badge tone={g.pass ? "green" : "red"}>{g.pass ? "pass" : "fail"}</Badge>
                          <span className="font-semibold capitalize">{g.gate}</span>
                          <span className="text-zinc-500">
                            {g.value} (needs {g.required})
                          </span>
                        </li>
                      ))}
                      {verdict.reasons.map((reason) => (
                        <li key={reason} className="text-rose-700">
                          {reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                  {creativeReport ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-semibold text-zinc-600">
                        Creative quality factors
                      </summary>
                      <ul className="mt-2 space-y-1.5 text-xs">
                        {creativeReport.factors.map((f) => (
                          <li key={f.id}>
                            <div className="flex items-center gap-2">
                              <span className="w-40 shrink-0">{f.label}</span>
                              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100">
                                <span
                                  className={`block h-full rounded-full ${f.score >= 80 ? "bg-emerald-500" : f.score >= 60 ? "bg-amber-500" : "bg-rose-500"}`}
                                  style={{ width: `${f.score}%` }}
                                />
                              </span>
                              <span className="w-8 text-right tabular-nums">{f.score}</span>
                            </div>
                            <p className="ml-40 pl-2 text-zinc-500">{f.notes.join(" · ")}</p>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-semibold text-zinc-600">
                      Technical checks
                    </summary>
                    <ul className="mt-2 space-y-1 text-xs">
                      {tech.checks.map((c) => (
                        <li key={c.id} className="flex flex-wrap items-center gap-2">
                          <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
                          <span className="font-semibold">{c.label}</span>
                          <span className="text-zinc-500">{c.value}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
