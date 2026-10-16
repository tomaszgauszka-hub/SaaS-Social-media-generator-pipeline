import fsp from "node:fs/promises";
import type { PrismaClient } from "@cre/db";
import {
  Asset3D,
  isUnrealTemplate,
  Recipe3D,
  type Asset3DInput,
  type EngineCapabilities,
  type RenderQuality,
} from "@cre/render3d/contracts";
import type { z } from "zod";
import { env } from "./db";
import { str } from "./form";
import {
  canonical,
  costAssumptionsFromEnv,
  DEMO_PRODUCTS,
  estimateRender,
  localRenderCost,
  onlineRenderStations,
  PrismaAssetLibrary3D,
  registerDemoProduct,
  routeRender,
  sha256,
  visualKey,
  type AssetLibrary3D,
  type LibraryLookup,
  type RouteDecision,
  type TimingSample,
} from "./render3d-runtime";
import { storage } from "./storage";

/*
 * 3D studio helpers (server only). The web app never probes Blender / Unreal (that spawns processes on the render
 * host): engine status comes from RenderStation heartbeats, and routing previews run the pure router with those
 * capabilities. Library reads are scoped to the signed-in user's workspace.
 */

/** A station whose heartbeat is younger than this is online (same window as the worker's router). */
export const STATION_ONLINE_MS = 120_000;
export const CLIP_TYPES = ["RENDER_CLIP", "RENDER_STILL_ALPHA"];

export type DemoProductId = keyof typeof DEMO_PRODUCTS;
export const isDemoProduct = (id: string): id is DemoProductId => Object.hasOwn(DEMO_PRODUCTS, id);

/** A library row is never trusted as is: every record is validated by the render3d contract. */
export function parseAsset(record: unknown): Asset3D | null {
  const r = Asset3D.safeParse(record);
  return r.success ? r.data : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Render station status (heartbeats)

export interface StationStatus {
  online: boolean;
  id: string | null;
  lastSeenAt: Date | null;
  activeJobs: number;
  /** capabilities of the freshest heartbeat (when offline: the last ones the station reported) */
  blender: EngineCapabilities | null;
  unreal: EngineCapabilities | null;
}

const text = (v: unknown, max = 200) => (typeof v === "string" && v ? v.slice(0, max) : null);

/** Heartbeat JSON → engine capabilities (defensive: a malformed heartbeat reads as "unavailable"). */
function toCaps(engine: "blender" | "unreal", raw: unknown): EngineCapabilities {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const gpu = (r.gpu && typeof r.gpu === "object" ? r.gpu : {}) as Record<string, unknown>;
  const available = r.available === true;
  return {
    engine,
    available,
    version: text(r.version),
    reason: available ? null : (text(r.reason, 300) ?? "not reported by the station"),
    gpu: {
      available: gpu.available === true,
      name: text(gpu.name),
      vramMb: typeof gpu.vramMb === "number" && Number.isFinite(gpu.vramMb) ? gpu.vramMb : null,
    },
    renderers: Array.isArray(r.renderers)
      ? r.renderers.filter((x): x is string => typeof x === "string").slice(0, 8)
      : [],
    host: text(r.host) ?? "",
  };
}

export async function stationStatus(prisma: PrismaClient, now = new Date()): Promise<StationStatus> {
  const online = (await onlineRenderStations(prisma, STATION_ONLINE_MS, now)).sort(
    (a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
  );
  const freshest = online[0] ?? (await prisma.renderStation.findFirst({ orderBy: { lastSeenAt: "desc" } }));
  if (!freshest)
    return { online: false, id: null, lastSeenAt: null, activeJobs: 0, blender: null, unreal: null };
  const caps = (
    freshest.capabilities && typeof freshest.capabilities === "object" ? freshest.capabilities : {}
  ) as Record<string, unknown>;
  return {
    online: online.length > 0,
    id: freshest.id,
    lastSeenAt: freshest.lastSeenAt,
    activeJobs: online.reduce((n, s) => n + s.activeJobs, 0),
    blender: toCaps("blender", caps.blender),
    unreal: toCaps("unreal", caps.unreal),
  };
}

function offlineCaps(engine: "blender" | "unreal", station: StationStatus): EngineCapabilities {
  return {
    engine,
    available: false,
    version: station.online ? null : (station[engine]?.version ?? null),
    reason: station.lastSeenAt
      ? `render station offline (last heartbeat ${station.lastSeenAt.toISOString()})`
      : "no render station has reported yet",
    gpu: { available: false, name: null, vramMb: null },
    renderers: [],
    host: station.id ?? "",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Library (workspace scoped)

/** Cache lookups limited to the workspace (the router must not reveal another workspace's clips). */
function workspaceLookup(prisma: PrismaClient, workspaceId: string): LibraryLookup {
  const find = async (where: { recipeHash: string } | { visualKey: string }) =>
    parseAsset(
      (
        await prisma.render3DAsset.findFirst({
          where: { ...where, workspaceId, approvalStatus: { not: "REJECTED" } },
          orderBy: { createdAt: "desc" },
          select: { record: true },
        })
      )?.record,
    );
  return {
    findByRecipeHash: (hash) => find({ recipeHash: hash }),
    findByVisualKey: (key) => find({ visualKey: key }),
  };
}

export function workspaceLibrary(prisma: PrismaClient, workspaceId: string): PrismaAssetLibrary3D {
  return new PrismaAssetLibrary3D(prisma, storage(), workspaceId);
}

/**
 * Builds a record without writing it: registerDemoProduct() against this library returns exactly the record a
 * real registration would store (dry runs must not write).
 */
class DryRunLibrary implements AssetLibrary3D {
  constructor(private readonly existing: Asset3D | null) {}
  get(assetId: string) {
    return Promise.resolve(this.existing?.assetId === assetId ? this.existing : null);
  }
  put(input: Asset3DInput) {
    return Promise.resolve(Asset3D.parse(input));
  }
  list() {
    return Promise.resolve([]);
  }
  findProductModel() {
    return Promise.resolve(null);
  }
  findByRecipeHash() {
    return Promise.resolve(null);
  }
  findByVisualKey() {
    return Promise.resolve(null);
  }
  setApproval(): Promise<Asset3D> {
    return Promise.reject(new Error("dry run library is read-only"));
  }
  localPath() {
    return Promise.resolve(null);
  }
  timingHistory(): Promise<TimingSample[]> {
    return Promise.resolve([]);
  }
}

export interface ProductOption {
  assetId: string;
  label: string;
  demo: boolean;
  /** already in the library (demo products are registered on the first render) */
  registered: boolean;
  fidelity: string;
  isDemoOnly: boolean;
  structureVerified: boolean;
  license: string;
  parts: { name: string; role: string; internal: boolean }[];
}

function optionFromAsset(a: Asset3D, demo: boolean): ProductOption {
  return {
    assetId: a.assetId,
    label: demo
      ? (DEMO_PRODUCTS[a.assetId]?.description.split(":")[0] ?? a.assetId).slice(0, 70)
      : `${a.assetId} · ${a.category} · v${a.version}`,
    demo,
    registered: true,
    fidelity: a.fidelity,
    isDemoOnly: a.isDemoOnly,
    structureVerified: a.structureVerified,
    license: a.license,
    parts: a.parts.map((p) => ({ name: p.name, role: p.role, internal: p.internal })),
  };
}

/** Product models of the workspace (not rejected) + the repo's demo products (registered on first use). */
export async function productOptions(prisma: PrismaClient, workspaceId: string): Promise<ProductOption[]> {
  const rows = await prisma.render3DAsset.findMany({
    where: { assetType: "PRODUCT_MODEL", workspaceId, approvalStatus: { not: "REJECTED" } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { record: true },
  });
  const own = rows
    .map((r) => parseAsset(r.record))
    .filter((a): a is Asset3D => a !== null && !isDemoProduct(a.assetId))
    .map((a) => optionFromAsset(a, false));
  const demos = await Promise.all(
    Object.keys(DEMO_PRODUCTS).map(async (id) => {
      const existing = parseAsset((await prisma.render3DAsset.findUnique({ where: { id } }))?.record);
      const model = await registerDemoProduct(new DryRunLibrary(existing), id);
      return { ...optionFromAsset(model, true), registered: existing !== null };
    }),
  );
  return [...own, ...demos];
}

/**
 * The product model a recipe shows: a (not rejected) model of the workspace, or a demo product — as the record a
 * registration would produce (nothing is written here).
 */
export async function resolveProductModel(
  prisma: PrismaClient,
  workspaceId: string,
  assetId: string,
): Promise<Asset3D | null> {
  const row = await prisma.render3DAsset.findUnique({
    where: { id: assetId },
    select: { workspaceId: true, assetType: true, approvalStatus: true, record: true },
  });
  if (isDemoProduct(assetId)) {
    const existing = row?.assetType === "PRODUCT_MODEL" ? parseAsset(row.record) : null;
    return registerDemoProduct(new DryRunLibrary(existing), assetId);
  }
  if (!row || row.workspaceId !== workspaceId || row.assetType !== "PRODUCT_MODEL") return null;
  if (row.approvalStatus === "REJECTED") return null;
  return parseAsset(row.record);
}

// ---------------------------------------------------------------------------------------------------------------
// Recipes from the form

export const FORM_FIELDS = [
  "productAssetId",
  "materialType",
  "engine",
  "template",
  "camera",
  "movement",
  "lighting",
  "background",
  "environment",
  "focus",
  "durationSec",
] as const;
export type FormField = (typeof FORM_FIELDS)[number] | "_form";

/** Raw recipe input from the "Generate 3D material" form (validated by Recipe3D afterwards). */
export function recipeInputFromForm(form: FormData, quality: RenderQuality): Record<string, unknown> {
  const s = (k: string) => str(form, k);
  const duration = s("durationSec").replace(",", ".");
  return {
    engine: s("engine") || "AUTO",
    template: s("template"),
    productAssetId: s("productAssetId"),
    durationSec: duration === "" ? undefined : Number(duration),
    camera: { preset: s("camera"), movement: s("movement") || "slow" },
    lighting: { preset: s("lighting") },
    background: { preset: s("background") },
    ...(s("environment") ? { environment: { preset: s("environment") } } : {}),
    ...(s("focus") ? { focus: s("focus") } : {}),
    quality,
  };
}

/** Zod issues → one owner-readable message per form field. */
export function recipeFieldErrors(error: z.ZodError): Partial<Record<FormField, string>> {
  const out: Partial<Record<FormField, string>> = {};
  for (const issue of error.issues) {
    const head = String(issue.path[0] ?? "");
    let field: FormField;
    if (head === "camera") field = issue.path[1] === "movement" ? "movement" : "camera";
    else if (head === "lighting" || head === "background" || head === "environment") field = head;
    else if (head === "productAssetId" || head === "engine" || head === "template" || head === "focus")
      field = head;
    else if (head === "durationSec") field = "durationSec";
    else if (/environment/.test(issue.message)) field = "environment";
    else if (/Unreal/.test(issue.message)) field = "template";
    else field = "_form";
    if (out[field]) continue;
    if (field === "durationSec") out[field] = "Enter a duration between 0.5 and 20 seconds.";
    else if (field === "productAssetId") out[field] = "Choose a product model.";
    else if (field === "focus") out[field] = "Pick a part of the model (or none).";
    else if (field === "environment" && issue.code === "custom")
      out[field] = "This template / background needs an environment.";
    else if (field === "template" && issue.code === "custom") out[field] = issue.message;
    else if (issue.code === "invalid_value" || issue.code === "invalid_type")
      out[field] = "Pick one of the listed options.";
    else out[field] = issue.message;
  }
  return out;
}

/**
 * Deterministic render job id: the same recipe (all defaults applied, quality included) in the same workspace
 * always gives the same id, so a double submit enqueues once (the outbox is idempotent per job id).
 */
export function renderJobId(workspaceId: string, recipe: Recipe3D): string {
  return `r3d-${sha256(canonical({ v: 1, workspaceId, recipe })).slice(0, 32)}`;
}

/** Outbox idempotency key used by enqueueRender3d (packages/pipeline/src/steps/render3d.ts). */
export const renderJobKey = (jobId: string) => `render3d.produce:${jobId}`;

// ---------------------------------------------------------------------------------------------------------------
// Routing dry run

export interface RoutePreview {
  engine: string;
  askedTemplate: string;
  template: string | null;
  quality: string;
  reasons: string[];
  rejected: { engine: string; why: string }[];
  existingAssetId: string | null;
  estimate: {
    seconds: number;
    costUsd: number;
    device: string;
    engine: string;
    frames: number;
    size: string;
    source: string;
    /** computed by the web app for a deferred job (the router gives no estimate while the station is offline) */
    planning: boolean;
  } | null;
  previewFirst: boolean;
  stationOnline: boolean;
  production: { ready: boolean; message: string } | null;
}

export async function routePreview(
  prisma: PrismaClient,
  workspaceId: string,
  recipe: Recipe3D,
  product: Asset3D | null,
  station: StationStatus,
): Promise<{ decision: RouteDecision; preview: RoutePreview }> {
  const e = env();
  const cost = costAssumptionsFromEnv(process.env);
  const history = await workspaceLibrary(prisma, workspaceId).timingHistory();
  const decision = await routeRender(
    { recipe, product },
    {
      blender: station.online && station.blender ? station.blender : offlineCaps("blender", station),
      unreal: station.online && station.unreal ? station.unreal : offlineCaps("unreal", station),
      workerOnline: station.online,
      library: workspaceLookup(prisma, workspaceId),
      history,
      settings: {
        skip3dWhenWorkerOffline: e.RENDER3D_SKIP_WHEN_OFFLINE,
        minValueFor3d: e.RENDER3D_MIN_VALUE,
      },
      cost,
    },
  );
  let estimate: RoutePreview["estimate"] = null;
  if (decision.estimate) {
    estimate = {
      seconds: Math.round(decision.estimate.totalMs / 1000),
      costUsd: decision.estimate.costUsd,
      device: decision.estimate.device,
      engine: decision.engine === "UNREAL" ? "unreal" : "blender",
      frames: decision.estimate.frames,
      size: `${decision.estimate.width}×${decision.estimate.height}`,
      source: decision.estimate.source,
      planning: false,
    };
  } else if (decision.engine === "DEFER" && decision.recipe) {
    // planning estimate on the last reported hardware (the router only estimates for an online station)
    const engine = isUnrealTemplate(decision.recipe.template) ? "unreal" : "blender";
    const caps = station[engine];
    const device = caps?.gpu.available || engine === "unreal" ? "GPU" : "CPU";
    const est = estimateRender(decision.recipe, engine, device, history);
    estimate = {
      seconds: Math.round(est.totalMs / 1000),
      costUsd: localRenderCost(est.totalMs, device, cost).usd,
      device,
      engine,
      frames: est.frames,
      size: `${est.width}×${est.height}`,
      source: est.source,
      planning: true,
    };
  }
  return {
    decision,
    preview: {
      engine: decision.engine,
      askedTemplate: recipe.template,
      template: decision.recipe?.template ?? null,
      quality: recipe.quality,
      reasons: decision.reasons,
      rejected: decision.rejected,
      existingAssetId: decision.existingAsset?.assetId ?? null,
      estimate,
      previewFirst: decision.previewFirst,
      stationOnline: station.online,
      production: null,
    },
  };
}

/**
 * Production gate (mirrors the render worker's RENDER3D_REQUIRE_APPROVED_PREVIEW check, which stays authoritative):
 * a production render needs an owner-approved preview of the same recipe. Checked against the asked recipe and the
 * routed one (e.g. an Unreal template mapped to its Blender equivalent).
 */
export async function productionGate(
  prisma: PrismaClient,
  workspaceId: string,
  recipes: (Recipe3D | null)[],
  product: Asset3D,
): Promise<{ ready: boolean; message: string }> {
  if (!env().RENDER3D_REQUIRE_APPROVED_PREVIEW)
    return {
      ready: true,
      message: "Production unlocked: an approved preview is not required on this setup.",
    };
  const keys = [
    ...new Set(
      recipes
        .filter((r): r is Recipe3D => r !== null)
        .map((r) => visualKey(Recipe3D.parse({ ...r, quality: "preview" }), product)),
    ),
  ];
  const previews = await prisma.render3DAsset.findMany({
    where: { workspaceId, visualKey: { in: keys } },
    orderBy: { createdAt: "desc" },
    select: { id: true, approvalStatus: true },
  });
  const approved = previews.find((p) => p.approvalStatus === "APPROVED");
  if (approved) return { ready: true, message: `Production unlocked: preview ${approved.id} is approved.` };
  const latest = previews[0];
  if (!latest)
    return {
      ready: false,
      message:
        "Production needs an approved preview of this exact recipe — render a preview first, then approve it in the library.",
    };
  return {
    ready: false,
    message:
      latest.approvalStatus === "REJECTED"
        ? `Production needs an approved preview — preview ${latest.id} was rejected. Change the recipe or regenerate the shot, then approve a new preview.`
        : `Production needs an approved preview — preview ${latest.id} is still awaiting approval. Approve it in the library below first.`,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Regeneration

const MAX_METADATA_BYTES = 8 * 1024 * 1024;

/** The recipe a clip was rendered from: its metadata file (written by the worker), else the job that made it. */
export async function clipRecipe(
  prisma: PrismaClient,
  workspaceId: string,
  clip: Asset3D,
): Promise<Recipe3D | null> {
  const meta = clip.outputFiles.find((f) => f.role === "metadata");
  if (meta && meta.sizeBytes <= MAX_METADATA_BYTES) {
    try {
      const file = await storage().getLocalPath(meta.key);
      const json = JSON.parse(await fsp.readFile(file, "utf8")) as { recipe?: unknown };
      const r = Recipe3D.safeParse(json.recipe);
      if (r.success) return r.data;
    } catch {
      /* fall back to the job payload */
    }
  }
  const job = await prisma.generationJob.findFirst({
    where: { workspaceId, type: "render3d.produce", result: { path: ["assetId"], equals: clip.assetId } },
    orderBy: { createdAt: "desc" },
    select: { payload: true },
  });
  const payload = (job?.payload ?? {}) as { recipe?: unknown };
  const r = Recipe3D.safeParse(payload.recipe);
  return r.success ? r.data : null;
}

/**
 * The same recipe with the next seed that has neither a job nor a clip yet (deterministic: a double click picks the
 * same seed, so the outbox enqueues once).
 */
export async function nextSeedRecipe(
  prisma: PrismaClient,
  workspaceId: string,
  recipe: Recipe3D,
  product: Asset3D,
): Promise<{ recipe: Recipe3D; jobId: string }> {
  const candidates = Array.from({ length: 32 }, (_, i) => {
    const r = Recipe3D.parse({ ...recipe, seed: (recipe.seed + i + 1) % 2_147_483_647 });
    return { recipe: r, jobId: renderJobId(workspaceId, r), visualKey: visualKey(r, product) };
  });
  const [jobs, clips] = await Promise.all([
    prisma.generationJob.findMany({
      where: { idempotencyKey: { in: candidates.map((c) => renderJobKey(c.jobId)) } },
      select: { idempotencyKey: true },
    }),
    prisma.render3DAsset.findMany({
      where: { workspaceId, visualKey: { in: candidates.map((c) => c.visualKey) } },
      select: { visualKey: true },
    }),
  ]);
  const usedJobs = new Set(jobs.map((j) => j.idempotencyKey));
  const usedKeys = new Set(clips.map((c) => c.visualKey));
  const free =
    candidates.find((c) => !usedJobs.has(renderJobKey(c.jobId)) && !usedKeys.has(c.visualKey)) ??
    candidates.at(-1)!;
  return { recipe: free.recipe, jobId: free.jobId };
}
