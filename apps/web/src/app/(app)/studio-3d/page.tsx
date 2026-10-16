import type { Metadata } from "next";
import type { Prisma } from "@cre/db";
import {
  BACKGROUND_PRESETS,
  BLENDER_TEMPLATES,
  CAMERA_PRESETS,
  defaultRecipe,
  ENGINE_MODES,
  ENVIRONMENT_PRESETS,
  LIGHTING_PRESETS,
  MATERIAL_TYPES_3D,
  MOVEMENTS,
  STRUCTURAL_TEMPLATES,
  TEMPLATE_MATERIAL,
  UNREAL_TEMPLATES,
  type Asset3D,
  type EngineCapabilities,
} from "@cre/render3d/contracts";
import { retryJobAction } from "@/app/actions/jobs";
import { ActionButton } from "@/components/action-button";
import { Clip3DCard, type ClipView } from "@/components/render3d-clip-card";
import { Render3DForm, type MaterialDefaults, type Render3DFormOptions } from "@/components/render3d-form";
import { Badge, Card, EmptyState, FilterLink, PageHeader, StatusBadge } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db, env } from "@/lib/db";
import { dateTime, relative } from "@/lib/format";
import { CLIP_TYPES, parseAsset, productOptions, stationStatus, type StationStatus } from "@/lib/render3d";
import { durationLabel, localCostLabel, templateLabel } from "@/lib/render3d-labels";

export const metadata: Metadata = { title: "3D materials" };

/**
 * 3D studio: render-station status, the "generate 3D material" form (router dry run + queued renders), the render
 * queue and the clip library with owner approval. Renders run on the local render station through the job queue —
 * nothing here calls a paid service or publishes.
 */

const APPROVAL_FILTERS: Record<string, string> = {
  PENDING: "Awaiting approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};
const RETRYABLE = new Set(["FAILED", "DEAD_LETTER", "BUDGET_BLOCKED", "CANCELLED"]);

function EngineRow({ name, caps, stale }: { name: string; caps: EngineCapabilities | null; stale: boolean }) {
  if (!caps)
    return (
      <li className="flex gap-2">
        <span aria-hidden className="w-4 text-zinc-400">
          ?
        </span>
        <span>
          <strong>{name}</strong> <span className="text-zinc-500">— not reported yet</span>
        </span>
      </li>
    );
  const gpu = caps.gpu.available
    ? `GPU ${caps.gpu.name ?? ""}${caps.gpu.vramMb ? ` (${Math.round(caps.gpu.vramMb / 1024)} GB)` : ""}`.trim()
    : "CPU only (no GPU)";
  return (
    <li className={`flex gap-2 ${stale ? "text-zinc-500" : ""}`}>
      <span aria-hidden className={`w-4 font-bold ${caps.available ? "text-emerald-600" : "text-rose-600"}`}>
        {caps.available ? "✓" : "✕"}
      </span>
      <span className="min-w-0 break-words">
        <strong>{name}</strong>{" "}
        {caps.available ? (
          <>
            {caps.version ? caps.version.replace(name, "").trim() || caps.version : "version unknown"} · {gpu}
            {caps.renderers.length ? ` · ${caps.renderers.join(", ")}` : ""}
          </>
        ) : (
          <span className="text-zinc-600">unavailable — {caps.reason ?? "no reason reported"}</span>
        )}
      </span>
    </li>
  );
}

function StationCard({
  station,
  running,
  timezone,
}: {
  station: StationStatus;
  /** render jobs of this workspace in progress (the periodic heartbeat reports 0 while a job runs) */
  running: number;
  timezone: string;
}) {
  const active = Math.max(station.activeJobs, running);
  return (
    <Card
      title="Render station"
      actions={station.online ? <Badge tone="green">● online</Badge> : <Badge tone="amber">○ offline</Badge>}
    >
      {station.online ? (
        <p className="text-sm text-zinc-700">
          <span className="font-semibold">{station.id}</span> · last heartbeat {relative(station.lastSeenAt)}{" "}
          · {active ? `${active} render(s) running` : "idle"}
        </p>
      ) : (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-semibold">
            Render station offline — queued renders wait and resume by themselves when it is back.
          </p>
          <p className="mt-1 text-xs">
            {station.lastSeenAt
              ? `Last heartbeat ${relative(station.lastSeenAt)} (${dateTime(station.lastSeenAt, timezone)}, ${station.id}).`
              : "No render station has reported yet — start the worker on the render host (pnpm worker, queue render_3d)."}{" "}
            You can still generate below: jobs are queued and deferred, not lost.
          </p>
        </div>
      )}
      <ul className="mt-3 space-y-1.5 text-sm">
        <EngineRow name="Blender" caps={station.blender} stale={!station.online} />
        <EngineRow name="Unreal Engine" caps={station.unreal} stale={!station.online} />
      </ul>
      {!station.online && (station.blender || station.unreal) ? (
        <p className="mt-2 text-xs text-zinc-500">Engine status as last reported by the station.</p>
      ) : null}
    </Card>
  );
}

interface JobPayload {
  recipe?: { template?: string; quality?: string; productAssetId?: string; seed?: number };
}
interface JobResult {
  engine?: string;
  assetId?: string | null;
  reasons?: string[];
  reused?: boolean;
  qaScore?: number | null;
}

function clipView(a: Asset3D, timezone: string): ClipView {
  const has = (role: string) => a.outputFiles.some((f) => f.role === role);
  return {
    assetId: a.assetId,
    materialType: a.materialType,
    template: a.template,
    quality: a.quality,
    engine: a.engine,
    engineVersion: a.engineVersion,
    fidelity: a.fidelity,
    isDemoOnly: a.isDemoOnly,
    isProductVerified: a.isProductVerified,
    license: a.license,
    licenseEvidence: a.licenseEvidence,
    source: a.source,
    productModelId: a.parentAssetIds[0] ?? a.productId,
    renderTime: durationLabel(a.renderTimeMs ?? a.telemetry?.renderDurationMs),
    cost: localCostLabel(a.renderCostEstimateUsd),
    qaScore: a.qa?.score ?? null,
    qaPassed: a.qa?.passed ?? null,
    qaNote: a.qa?.note ?? null,
    failedChecks: (a.qa?.checks ?? [])
      .filter((c) => !c.ok)
      .slice(0, 8)
      .map((c) => ({ id: c.id, severity: c.severity, message: c.message })),
    approval: {
      status: a.approval.status,
      by: a.approval.by,
      at: a.approval.at ? dateTime(new Date(a.approval.at), timezone) : null,
      note: a.approval.note,
    },
    files: {
      video: has("video"),
      thumbnail: has("thumbnail"),
      controlSheet: has("control_sheet"),
      alphaVideo: has("alpha_video"),
      metadata: has("metadata"),
    },
    resolution: a.resolution,
    length: durationLabel(a.durationMs),
    fps: a.fps,
    created: dateTime(new Date(a.createdAt), timezone),
    device: a.telemetry?.device ?? null,
    host: a.telemetry?.host || null,
    recipeHash: a.recipeHash,
    storyboardRef: JSON.stringify(
      {
        assetId: a.assetId,
        materialType: a.materialType,
        recipeHash: a.recipeHash,
        engine: a.engine,
        fidelity: a.fidelity,
      },
      null,
      2,
    ),
  };
}

function materialDefaults(): Record<string, MaterialDefaults> {
  return Object.fromEntries(
    MATERIAL_TYPES_3D.map((m) => {
      const r = defaultRecipe(m, "preview");
      return [
        m,
        {
          template: r.template,
          camera: r.camera?.preset ?? "orbit_closeup",
          movement: r.camera?.movement ?? "slow",
          lighting: r.lighting?.preset ?? "premium_studio",
          background: r.background?.preset ?? "dark_gradient",
          environment: r.environment?.preset ?? "",
          durationSec: r.durationSec,
        },
      ];
    }),
  );
}

export default async function Studio3dPage({
  searchParams,
}: {
  searchParams: Promise<{ approval?: string }>;
}) {
  const user = await requireUser();
  const { approval } = await searchParams;
  const approvalFilter = approval && approval in APPROVAL_FILTERS ? approval : undefined;
  const prisma = db();
  const clipWhere: Prisma.Render3DAssetWhereInput = {
    workspaceId: user.workspaceId,
    assetType: { in: CLIP_TYPES },
  };
  const [station, products, rows, counts, jobs, running] = await Promise.all([
    stationStatus(prisma),
    productOptions(prisma, user.workspaceId),
    prisma.render3DAsset.findMany({
      where: { ...clipWhere, ...(approvalFilter ? { approvalStatus: approvalFilter } : {}) },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: { record: true },
    }),
    prisma.render3DAsset.groupBy({ by: ["approvalStatus"], where: clipWhere, _count: { _all: true } }),
    prisma.generationJob.findMany({
      where: { workspaceId: user.workspaceId, type: "render3d.produce" },
      orderBy: { updatedAt: "desc" },
      take: 8,
      select: {
        id: true,
        status: true,
        lastError: true,
        errorClass: true,
        payload: true,
        result: true,
        updatedAt: true,
        runAt: true,
        attempts: true,
        maxAttempts: true,
      },
    }),
    prisma.generationJob.count({
      where: { workspaceId: user.workspaceId, type: "render3d.produce", status: "RUNNING" },
    }),
  ]);
  const clips = rows
    .map((r) => parseAsset(r.record))
    .filter((a): a is Asset3D => a !== null)
    .map((a) => clipView(a, user.timezone));
  const count = (s?: string) =>
    counts.filter((c) => !s || c.approvalStatus === s).reduce((n, c) => n + c._count._all, 0);

  const options: Render3DFormOptions = {
    products,
    materialTypes: [...MATERIAL_TYPES_3D],
    defaults: materialDefaults(),
    templateMaterial: TEMPLATE_MATERIAL,
    engines: [...ENGINE_MODES],
    blenderTemplates: [...BLENDER_TEMPLATES],
    unrealTemplates: [...UNREAL_TEMPLATES],
    structuralTemplates: [...STRUCTURAL_TEMPLATES],
    cameras: [...CAMERA_PRESETS],
    movements: [...MOVEMENTS],
    lightings: [...LIGHTING_PRESETS],
    backgrounds: [...BACKGROUND_PRESETS],
    environments: [...ENVIRONMENT_PRESETS],
    stationOnline: station.online,
    requireApprovedPreview: env().RENDER3D_REQUIRE_APPROVED_PREVIEW,
  };

  return (
    <>
      <PageHeader
        title="3D materials"
        subtitle="Product clips rendered locally on the render station (Blender / Unreal Engine) for storyboards — no paid services, nothing is published from here. Every clip needs your approval before it is used."
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:grid-rows-[auto_1fr] lg:items-start">
        <div className="lg:col-start-2 lg:row-start-1">
          <StationCard station={station} running={running} timezone={user.timezone} />
        </div>

        <div className="lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <Card title="Generate 3D material">
            <Render3DForm options={options} />
          </Card>
        </div>

        <div className="lg:col-start-2 lg:row-start-2">
          <Card title="Render queue">
            {jobs.length === 0 ? (
              <p className="text-sm text-zinc-500">No 3D renders queued yet.</p>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {jobs.map((j) => {
                  const recipe = (j.payload as JobPayload | null)?.recipe ?? {};
                  const result = (j.result ?? {}) as JobResult;
                  const deferred = j.status === "RETRYING" && /deferred/i.test(j.lastError ?? "");
                  // marked RUNNING, but the station stopped heart-beating: the dispatcher retries it automatically
                  // once it is twice its timeout old (packages/pipeline/src/dispatch/bullmq.ts recoverStale)
                  const interrupted = j.status === "RUNNING" && !station.online;
                  return (
                    <li key={j.id} className="py-2 text-sm first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {deferred ? (
                          <Badge tone="amber">waiting for station</Badge>
                        ) : interrupted ? (
                          <Badge tone="amber">interrupted</Badge>
                        ) : (
                          <StatusBadge status={j.status} />
                        )}
                        <span className="font-semibold">{templateLabel(recipe.template)}</span>
                        <span className="text-xs text-zinc-500">
                          {recipe.quality ?? "preview"} · {recipe.productAssetId ?? "—"}
                          {recipe.seed && recipe.seed !== 1 ? ` · seed ${recipe.seed}` : ""}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        updated {relative(j.updatedAt)}
                        {j.status === "RETRYING" || j.status === "QUEUED"
                          ? ` · next attempt ${dateTime(j.runAt, user.timezone)}`
                          : ""}
                        {j.status !== "SUCCEEDED" ? ` · attempt ${j.attempts}/${j.maxAttempts}` : ""}
                      </p>
                      {interrupted ? (
                        <p className="mt-0.5 text-xs text-amber-800">
                          The render station went offline during this render — it is retried automatically
                          when a station is back.
                        </p>
                      ) : null}
                      {j.status === "SUCCEEDED" ? (
                        <p className="mt-0.5 text-xs text-zinc-600">
                          {result.assetId ? (
                            <>
                              {result.reused ? "Reused " : "Rendered "}
                              <a href={`#${result.assetId}`} className="font-mono text-brand-700 underline">
                                {result.assetId}
                              </a>
                              {typeof result.qaScore === "number"
                                ? ` · QA ${Math.round(result.qaScore)}/100`
                                : ""}
                            </>
                          ) : (
                            `No 3D clip: ${result.reasons?.join("; ") ?? result.engine ?? "routed elsewhere"}`
                          )}
                        </p>
                      ) : null}
                      {j.lastError && j.status !== "SUCCEEDED" ? (
                        <p
                          className={`mt-0.5 text-xs break-words ${deferred ? "text-amber-800" : "text-rose-700"}`}
                        >
                          {j.errorClass === "fatal" ? "Rejected by the render worker: " : ""}
                          {j.lastError}
                        </p>
                      ) : null}
                      {RETRYABLE.has(j.status) ? (
                        <div className="mt-1">
                          <ActionButton
                            action={retryJobAction.bind(null, { jobId: j.id })}
                            label="Retry"
                            className="btn-secondary min-h-9 px-3 text-xs"
                          />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <section className="mt-8" aria-labelledby="library-heading">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <h2 id="library-heading" className="text-lg font-bold tracking-tight">
            Library
          </h2>
          <p className="text-xs text-zinc-500">
            Clips of this workspace, newest first — an approved preview unlocks the production render
          </p>
        </div>
        <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
          <FilterLink href="/studio-3d" active={!approvalFilter}>
            All ({count()})
          </FilterLink>
          {Object.entries(APPROVAL_FILTERS).map(([key, label]) => (
            <FilterLink key={key} href={`/studio-3d?approval=${key}`} active={approvalFilter === key}>
              {label} ({count(key)})
            </FilterLink>
          ))}
        </div>
        {clips.length === 0 ? (
          <EmptyState title={approvalFilter ? "No clips with this status" : "No 3D clips yet"}>
            Pick a product model above and press “Render preview”. The clip lands here after the render
            station has rendered it and the automatic technical QA has run.
          </EmptyState>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {clips.map((c) => (
              <Clip3DCard key={c.assetId} clip={c} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
