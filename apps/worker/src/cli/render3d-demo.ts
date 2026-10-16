/**
 * 3D demonstrations (Test A: drill/driver, Test B: cosmetic tube) through the production render worker:
 * router → Blender → encode → clip QA → library (PostgreSQL + Storage) → telemetry + local cost.
 *
 *   pnpm --filter @cre/worker render3d:demo [--test A|B|all] [--quality preview|production] [--no-db]
 *                                           [--only A1,B3] [--out .data/render3d-demo]
 *
 * Both products are the repo's DEMO_ONLY benchmark products modelled procedurally (FICTIONAL_DEMO): every clip is
 * DEMO_ONLY and can never be published. Nothing is posted anywhere.
 */
import fs from "node:fs";
import path from "node:path";
import { getEnv, resolveFromRoot } from "@cre/config";
import { createPrismaClient, type PrismaClient } from "@cre/db";
import { PrismaAssetLibrary3D } from "@cre/pipeline";
import { createStorageProvider } from "@cre/providers";
import {
  createRender3D,
  registerDemoProduct,
  type Asset3D,
  type Recipe3DInput,
  type RenderJob3DResult,
} from "@cre/render3d";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

interface DemoClip {
  id: string;
  title: string;
  product: "demo-drill-20v" | "demo-sunscreen-tube";
  recipe: Omit<Recipe3DInput, "productAssetId">;
}

export const DEMO_A: DemoClip[] = [
  {
    id: "A1",
    title: "Obrót 360° wiertarko-wkrętarki",
    product: "demo-drill-20v",
    recipe: {
      template: "TURNTABLE_360",
      durationSec: 4,
      camera: { preset: "turntable", movement: "static" },
      lighting: { preset: "high_key" },
      background: { preset: "light_gradient" },
      turns: 1,
    },
  },
  {
    id: "A2",
    title: "Makro uchwytu wiertarskiego (13 mm, bezkluczykowy)",
    product: "demo-drill-20v",
    recipe: {
      template: "MACRO_DETAIL",
      durationSec: 3,
      focus: "chuck",
      camera: { preset: "macro_slide", movement: "slow" },
      lighting: { preset: "dramatic_rim" },
      background: { preset: "dark_gradient" },
    },
  },
  {
    id: "A3",
    title: "Animacja: spust, światło LED i obrót uchwytu",
    product: "demo-drill-20v",
    recipe: {
      template: "PRODUCT_HERO",
      durationSec: 4,
      camera: { preset: "push_in", movement: "slow" },
      lighting: { preset: "premium_studio" },
      background: { preset: "dark_gradient" },
      actions: [
        { kind: "TRIGGER_PRESS", startSec: 0.8, endSec: 1.2 },
        { kind: "LED_ON", startSec: 0.9, endSec: 1.3 },
        { kind: "CHUCK_SPIN", startSec: 1.0, endSec: 2.2 },
      ],
    },
  },
  {
    id: "A4",
    title: "Prezentacja w warsztacie",
    product: "demo-drill-20v",
    recipe: {
      template: "LIFESTYLE",
      durationSec: 4,
      camera: { preset: "push_in", movement: "slow" },
      lighting: { preset: "workshop_practical" },
      background: { preset: "environment" },
      environment: { preset: "workshop" },
    },
  },
  {
    id: "A5",
    title: "Product Hero (+ widoki kontrolne, eksport FBX/GLB do UE)",
    product: "demo-drill-20v",
    recipe: {
      template: "PRODUCT_HERO",
      durationSec: 4,
      camera: { preset: "orbit_closeup", movement: "slow" },
      lighting: { preset: "premium_studio" },
      background: { preset: "dark_gradient" },
      outputs: ["video", "thumbnail", "metadata", "control_views", "export_fbx", "export_glb", "blend"],
    },
  },
  {
    id: "A6",
    title: "Widok rozłożony (struktura modelu demo)",
    product: "demo-drill-20v",
    recipe: {
      template: "EXPLODED_VIEW",
      durationSec: 5,
      camera: { preset: "orbit_wide", movement: "slow" },
      lighting: { preset: "premium_studio" },
      background: { preset: "light_gradient" },
      framing: { centerY: 0.5, fill: 0.66 },
    },
  },
  {
    id: "A7",
    title: "Wizualizacja techniczna (ilustracyjna): napęd w przekroju",
    product: "demo-drill-20v",
    recipe: {
      template: "TECHNICAL",
      durationSec: 4,
      camera: { preset: "dolly_side", movement: "slow" },
      lighting: { preset: "cool_tech" },
      background: { preset: "dark_gradient" },
    },
  },
];

export const DEMO_B: DemoClip[] = [
  {
    id: "B1",
    title: "Premium packshot (+ widoki kontrolne)",
    product: "demo-sunscreen-tube",
    recipe: {
      template: "PRODUCT_HERO",
      durationSec: 4,
      camera: { preset: "orbit_closeup", movement: "slow" },
      lighting: { preset: "premium_studio" },
      background: { preset: "soft_pastel" },
      outputs: ["video", "thumbnail", "metadata", "control_views"],
    },
  },
  {
    id: "B2",
    title: "Obrót produktu",
    product: "demo-sunscreen-tube",
    recipe: {
      template: "TURNTABLE_360",
      durationSec: 4,
      camera: { preset: "turntable", movement: "static" },
      lighting: { preset: "high_key" },
      background: { preset: "light_gradient" },
    },
  },
  {
    id: "B3",
    title: "Scena na łazienkowym blacie",
    product: "demo-sunscreen-tube",
    recipe: {
      template: "LIFESTYLE",
      durationSec: 4,
      camera: { preset: "push_in", movement: "slow" },
      lighting: { preset: "soft_daylight" },
      background: { preset: "environment" },
      environment: { preset: "bathroom" },
    },
  },
  {
    id: "B4",
    title: "Makro opakowania (zgrzew z ząbkowaniem)",
    product: "demo-sunscreen-tube",
    recipe: {
      template: "MACRO_DETAIL",
      durationSec: 3,
      focus: "crimp",
      camera: { preset: "macro_slide", movement: "slow" },
      lighting: { preset: "premium_studio" },
      background: { preset: "soft_pastel" },
    },
  },
  {
    id: "B5",
    title: "Animacja zbliżenia",
    product: "demo-sunscreen-tube",
    recipe: {
      template: "PRODUCT_HERO",
      durationSec: 3,
      camera: { preset: "push_in", movement: "fast" },
      lighting: { preset: "dramatic_rim" },
      background: { preset: "dark_gradient" },
    },
  },
];

export interface DemoRow {
  id: string;
  title: string;
  engine: string;
  reused: boolean;
  assetId: string | null;
  file: string | null;
  thumbnail: string | null;
  controlSheet: string | null;
  qaPassed: boolean | null;
  qaScore: number | null;
  failedChecks: string[];
  renderS: number;
  framesRendered: number;
  perFrameS: number | null;
  peakRamMb: number | null;
  cpuPct: number | null;
  costUsd: number;
  device: string;
  engineVersion: string | null;
  reasons: string[];
}

async function copyOut(
  lib: PrismaAssetLibrary3D | ReturnType<typeof createRender3D>["library"],
  a: Asset3D,
  role: "video" | "thumbnail" | "control_sheet",
  dest: string,
) {
  const src = await lib.localPath(a, role);
  if (!src) return null;
  fs.copyFileSync(src, dest);
  return dest;
}

export function rowOf(
  c: DemoClip,
  r: RenderJob3DResult,
  files: Pick<DemoRow, "file" | "thumbnail" | "controlSheet">,
): DemoRow {
  const t = r.telemetry;
  return {
    id: c.id,
    title: c.title,
    engine: r.decision.engine,
    reused: r.reused,
    assetId: r.asset?.assetId ?? null,
    ...files,
    qaPassed: r.qa?.passed ?? null,
    qaScore: r.qa?.score ?? null,
    failedChecks: r.qa?.checks.filter((x) => !x.ok).map((x) => `${x.id}=${String(x.value)}`) ?? [],
    renderS: Math.round((t?.renderDurationMs ?? 0) / 100) / 10,
    framesRendered: t?.framesRendered ?? 0,
    perFrameS: t?.perFrameMsMedian ? Math.round(t.perFrameMsMedian / 100) / 10 : null,
    peakRamMb: t?.peakRamMb ?? null,
    cpuPct: t?.cpuUsagePct ?? null,
    costUsd: r.cost?.usd ?? 0,
    device: t?.device ?? "",
    engineVersion: r.asset?.engineVersion ?? null,
    reasons: r.decision.reasons,
  };
}

async function main() {
  const env = getEnv();
  const which = (arg("test") ?? "all").toUpperCase();
  const quality = (arg("quality") ?? "preview") as "preview" | "production";
  const only = arg("only")
    ?.split(",")
    .map((s) => s.trim().toUpperCase());
  const out = resolveFromRoot(arg("out") ?? ".data/render3d-demo");
  fs.mkdirSync(out, { recursive: true });
  let prisma: PrismaClient | null = null;
  const storage = createStorageProvider(env);
  let library: PrismaAssetLibrary3D | undefined;
  if (!flag("no-db")) {
    prisma = createPrismaClient();
    const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
    library = new PrismaAssetLibrary3D(prisma, storage, ws?.id ?? null);
  }
  const r3d = createRender3D(env, { storage, ...(library ? { library } : {}) });
  const caps = await r3d.worker.capabilities(true);
  console.log(
    `Blender: ${caps.blender.version ?? caps.blender.reason} · Unreal: ${caps.unreal.version ?? caps.unreal.reason} · GPU: ${caps.blender.gpu.name ?? "none"}`,
  );
  const clips = [
    ...(which === "A" || which === "ALL" ? DEMO_A : []),
    ...(which === "B" || which === "ALL" ? DEMO_B : []),
  ].filter((c) => !only || only.includes(c.id));
  const rows: DemoRow[] = [];
  for (const c of clips) {
    await registerDemoProduct(r3d.library, c.product);
    const recipe: Recipe3DInput = {
      ...c.recipe,
      productAssetId: c.product,
      quality,
      resolution: [1080, 1920],
      fps: 30,
    };
    process.stdout.write(`▶ ${c.id} ${c.title} … `);
    const t0 = Date.now();
    let last = 0;
    const r = await r3d.worker.run(
      { jobId: `demo-${c.id.toLowerCase()}-${quality}`, recipe, requireApprovedPreview: false },
      {
        onProgress: (f, n) => {
          if (Date.now() - last > 60_000) {
            last = Date.now();
            process.stdout.write(`${f}/${n} `);
          }
        },
      },
    );
    const base = path.join(out, `${c.id}_${quality}`);
    const files = r.asset
      ? {
          file: await copyOut(r3d.library, r.asset, "video", `${base}.mp4`),
          thumbnail: await copyOut(r3d.library, r.asset, "thumbnail", `${base}.jpg`),
          controlSheet: await copyOut(r3d.library, r.asset, "control_sheet", `${base}_views.jpg`),
        }
      : { file: null, thumbnail: null, controlSheet: null };
    const row = rowOf(c, r, files);
    rows.push(row);
    console.log(
      `${row.engine}${row.reused ? " (cache)" : ""} · ${((Date.now() - t0) / 1000).toFixed(0)} s · QA ${row.qaScore} ${row.qaPassed ? "✓" : "✗"} ${row.failedChecks.join(" ")} · $${row.costUsd.toFixed(4)}`,
    );
    fs.writeFileSync(
      path.join(out, `summary_${quality}.json`),
      JSON.stringify({ quality, caps, rows }, null, 2),
    );
  }
  await prisma?.$disconnect();
}

if (process.argv[1]?.endsWith("render3d-demo.ts")) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
