/**
 * Test D — end-to-end reel with 3D clips through the existing Creative Engine V2:
 *
 *   product (demo 20V drill) → CreativeStoryboard (director) → 3D clip requests per beat → 3D render router →
 *   Blender renders → library (PostgreSQL + Storage) → storyboard media swap → Remotion (local) → music + SFX mix
 *   → on-screen text → technical / creative / factual / compliance / localization QA → preview stills + DB row
 *   (owner approval in the panel) — then the same reel in Polish (no 3D re-render) and an identical repeat (cache).
 *
 *   pnpm --filter @cre/worker render3d:reel [--quality preview|production] [--no-db] [--out .data/render3d-reel]
 *
 * DEMO_ONLY product: the reels can never be published, and nothing is posted anywhere.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEnv, resolveFromRoot } from "@cre/config";
import {
  complianceQa,
  CreativeBrief,
  creativeQa,
  directCreative,
  DIRECTOR_VERSION,
  evaluateGates,
  factualQa,
  LocalePack,
  localizationQa,
  resolveRenderPlan,
  type CreativeStoryboard,
  type VisualBeatType,
} from "@cre/creative";
import { BENCH_TOOLS } from "@cre/creative/benchmark";
import { fontAssets, FontkitMeasurer, stableHash } from "@cre/creative/node";
import { createPrismaClient, type PrismaClient } from "@cre/db";
import { getRenderEnv, renderFinishedReel, renderReelStills, technicalQa } from "@cre/motion";
import { PrismaAssetLibrary3D } from "@cre/pipeline";
import { assetStorageKey, createStorageProvider } from "@cre/providers";
import {
  apply3dClips,
  createRender3D,
  midAnchors,
  plan3dRequests,
  registerDemoProduct,
  serveMedia,
  transitionJump,
  type Asset3D,
  type PlacedClip,
} from "@cre/render3d";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const RENDERER_VERSION = "remotion-4.0.534/motion-v1+render3d/1";

/** beats that get a 3D clip; the torque gauge (NUMBER_STAT) and the spec list stay 2D overlays */
const BEATS_3D: VisualBeatType[] = [
  "HOOK_VISUAL",
  "PRODUCT_HERO",
  "PRODUCT_MACRO",
  "PRODUCT_IN_USE",
  "CTA_CARD",
];

interface ClipStat {
  beatId: string;
  materialType: string;
  template: string;
  engine: string;
  reused: boolean;
  assetId: string;
  renderS: number;
  qaScore: number | null;
  costUsd: number;
}

async function produceClips(
  r3d: ReturnType<typeof createRender3D>,
  sb: CreativeStoryboard,
  product: Asset3D,
  quality: "preview" | "production",
  tag: string,
): Promise<{ placed: PlacedClip[]; stats: ClipStat[]; files: Record<string, string> }> {
  const requests = plan3dRequests(sb, product, { only: BEATS_3D, environment: "workshop", quality });
  const placed: PlacedClip[] = [];
  const stats: ClipStat[] = [];
  const files: Record<string, string> = {};
  for (const req of requests) {
    const t0 = Date.now();
    process.stdout.write(`  ${tag} ${req.beatId} ${req.materialType} … `);
    const r = await r3d.worker.run({
      jobId: `reel3d-${req.beatId}-${stableHash(req.recipe).slice(0, 10)}`,
      recipe: req.recipe,
      requireApprovedPreview: false,
    });
    const asset = r.asset;
    if (!asset)
      throw new Error(`${req.beatId}: routed to ${r.decision.engine} (${r.decision.reasons.join("; ")})`);
    const video = await r3d.library.localPath(asset, "video");
    const metaPath = await r3d.library.localPath(asset, "metadata");
    const meta = metaPath
      ? (JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
          anchorTracks?: Record<string, ([number, number] | null)[]>;
        })
      : {};
    const name = `${asset.assetId}.mp4`;
    files[name] = video!;
    placed.push({ beatId: req.beatId, asset, src: name, anchors: midAnchors(meta.anchorTracks ?? {}) });
    stats.push({
      beatId: req.beatId,
      materialType: req.materialType,
      template: asset.template ?? "",
      engine: r.decision.engine,
      reused: r.reused,
      assetId: asset.assetId,
      renderS: Math.round((Date.now() - t0) / 100) / 10,
      qaScore: r.qa?.score ?? asset.qa?.score ?? null,
      costUsd: r.cost?.usd ?? 0,
    });
    console.log(
      `${r.decision.engine}${r.reused ? " (cache)" : ""} ${((Date.now() - t0) / 1000).toFixed(0)} s`,
    );
  }
  return { placed, stats, files };
}

async function storeReel(
  prisma: PrismaClient,
  workspaceId: string,
  file: string,
  poster: string,
  key: string,
) {
  const storage = createStorageProvider(getEnv());
  const ids: Record<string, string> = {};
  for (const [kind, local, ext, mime] of [
    ["RENDERED_VIDEO", file, "mp4", "video/mp4"],
    ["THUMBNAIL", poster, "jpg", "image/jpeg"],
  ] as const) {
    const idempotencyKey = `render3d-reel:${key}:${kind}`;
    const asset = await prisma.asset.upsert({
      where: { idempotencyKey },
      create: {
        workspaceId,
        kind,
        origin: "RENDERED",
        status: "PENDING",
        idempotencyKey,
        provider: "local-remotion+blender",
        license: "own · DEMO ONLY",
        isMock: true,
        metadata: { demoOnly: true, render3d: true },
      },
      update: {},
    });
    const stored = await storage.putFile(
      assetStorageKey({ workspaceId, assetId: asset.id, ext }),
      local,
      mime,
    );
    await prisma.asset.update({
      where: { id: asset.id },
      data: {
        status: "READY",
        storageKey: stored.key,
        mimeType: mime,
        sizeBytes: stored.sizeBytes,
        checksum: stored.checksum,
        width: 1080,
        height: 1920,
      },
    });
    ids[kind] = asset.id;
  }
  return ids;
}

async function main() {
  const env = getEnv();
  const quality = (arg("quality") ?? "preview") as "preview" | "production";
  const out = resolveFromRoot(arg("out") ?? ".data/render3d-reel");
  fs.mkdirSync(out, { recursive: true });
  const storage = createStorageProvider(env);
  let prisma: PrismaClient | null = null;
  let workspaceId: string | null = null;
  let library: PrismaAssetLibrary3D | undefined;
  if (!flag("no-db")) {
    prisma = createPrismaClient();
    workspaceId = (await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } }))?.id ?? null;
    library = new PrismaAssetLibrary3D(prisma, storage, workspaceId);
  }
  const r3d = createRender3D(env, { storage, ...(library ? { library } : {}) });
  const product = await registerDemoProduct(r3d.library, "demo-drill-20v");

  // 1–2: product → storyboard (the existing director, no LLM)
  const brief = CreativeBrief.parse(BENCH_TOOLS);
  const { storyboard: sb, localePack: en } = directCreative(brief);
  const pl = LocalePack.parse(
    JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "bench-tools.pl-PL.json"), "utf8")),
  );

  // 3–6: 3D clips for the beats (router → Blender → library)
  console.log(`▶ 3D clips for ${sb.id} (${quality})`);
  const first = await produceClips(r3d, sb, product, quality, "en-US");
  const sb3 = apply3dClips(sb, first.placed);

  // transitions between consecutive 3D clips (luma jump at the cut)
  const transitions: { from: string; to: string; jump: number }[] = [];
  for (let i = 1; i < first.placed.length; i++) {
    const a = first.placed[i - 1]!;
    const b = first.placed[i]!;
    transitions.push({
      from: a.beatId,
      to: b.beatId,
      jump: Math.round(await transitionJump(env.FFMPEG_PATH, first.files[a.src]!, first.files[b.src]!)),
    });
  }

  const server = await serveMedia(first.files);
  const env2 = await getRenderEnv();
  console.log(
    `Remotion bundle ${env2.bundleCached ? "cached" : `built in ${(env2.bundleMs / 1000).toFixed(1)} s`}`,
  );
  const measurer = new FontkitMeasurer();
  const { assets: fonts } = fontAssets(sb3.style);
  const storyboardHash = stableHash(sb3);
  const mediaUrls = Object.fromEntries(first.placed.map((c) => [c.asset.assetId, server.url(c.src)]));
  const reels: Record<string, unknown>[] = [];
  const cache: Record<string, unknown> = {};
  try {
    for (const pack of [en, pl]) {
      // a locale change: the clip requests are identical, so every clip must come from the library
      const run = pack === en ? first : await produceClips(r3d, sb, product, quality, pack.locale);
      if (pack !== en)
        cache.localeChange = {
          renders: run.stats.filter((s) => !s.reused).length,
          reused: run.stats.filter((s) => s.reused).length,
        };
      const { plan, issues } = resolveRenderPlan(sb3, pack, measurer, { fonts, storyboardHash, mediaUrls });
      const dir = path.join(out, pack.locale);
      const t0 = Date.now();
      const finished = await renderFinishedReel(plan, dir);
      const { report: technical } = await technicalQa(finished.file, plan);
      const creative = creativeQa({ storyboard: sb3, plan, resolveIssues: issues, technical });
      const factual = factualQa({ brief, pack, plan, ...(pack !== en ? { sourcePack: en } : {}) });
      const compliance = complianceQa({ storyboard: sb3, plan, pack, affiliate: Boolean(brief.disclosure) });
      const localization = localizationQa({ storyboard: sb3, pack, resolveIssues: issues });
      const verdict = evaluateGates({
        technical,
        creative,
        factual,
        compliance,
        localization,
        flags: sb3.flags,
      });
      const stills = await renderReelStills(
        plan,
        plan.beats.map((b) => Math.round(((b.startMs + b.durationMs * 0.6) / 1000) * plan.format.fps)),
        path.join(dir, "stills"),
      );
      const row: Record<string, unknown> = {
        locale: pack.locale,
        file: path.relative(resolveFromRoot("."), finished.file),
        poster: path.relative(resolveFromRoot("."), finished.poster),
        stills: stills.map((s) => path.relative(resolveFromRoot("."), s)),
        durationS: finished.info.durationMs / 1000,
        renderS: Math.round((Date.now() - t0) / 1000),
        technical: technical.status,
        creative: creative.score,
        factual: factual.status,
        compliance: compliance.status,
        localization: localization.status,
        verdict: verdict.label,
        productionReady: verdict.productionReady,
        failed: [...technical.checks, ...factual.checks, ...compliance.checks, ...localization.checks]
          .filter((c) => c.status === "fail")
          .map((c) => `${c.id}: ${String(c.value ?? "")}`),
      };
      if (prisma && workspaceId) {
        const ids = await storeReel(
          prisma,
          workspaceId,
          finished.file,
          finished.poster,
          `${storyboardHash.slice(0, 16)}:${pack.locale}`,
        );
        const rec = await prisma.creativeRender.create({
          data: {
            workspaceId,
            storyboardId: sb3.id,
            title: `${sb3.title} · 3D`,
            category: sb3.category,
            structure: sb3.structure,
            styleKit: sb3.style.kit,
            locale: plan.locale,
            benchmark: true,
            demoOnly: true,
            placeholderMedia: sb3.flags.placeholderMedia,
            durationMs: finished.info.durationMs,
            beatCount: plan.beats.length,
            width: plan.format.width,
            height: plan.format.height,
            fps: plan.format.fps,
            storyboardHash,
            planHash: stableHash(plan),
            videoAssetId: ids.RENDERED_VIDEO ?? null,
            posterAssetId: ids.THUMBNAIL ?? null,
            renderMs: finished.renderMs,
            audioMs: finished.audioMs,
            finishMs: finished.finishMs,
            qaMs: 0,
            renderFps: finished.renderFps,
            rendererVersion: RENDERER_VERSION,
            directorVersion: DIRECTOR_VERSION,
            technicalStatus: technical.status,
            technicalReport: JSON.parse(JSON.stringify(technical)) as object,
            storyboard: JSON.parse(JSON.stringify(sb3)) as object,
            productionReady: verdict.productionReady,
            verdictLabel: verdict.label,
            verdict: JSON.parse(JSON.stringify(verdict)) as object,
          },
        });
        row.creativeRenderId = rec.id;
      }
      reels.push(row);
      console.log(
        `  ${pack.locale}: ${row.durationS as number} s · ${String(row.verdict)} · technical ${technical.status} · ${String(row.renderS)} s`,
      );
    }
    // identical job again: pure cache
    const again = await produceClips(r3d, sb, product, quality, "repeat");
    cache.identicalJob = {
      renders: again.stats.filter((s) => !s.reused).length,
      reused: again.stats.filter((s) => s.reused).length,
    };
  } finally {
    await server.close();
  }
  const summary = {
    storyboard: sb3.id,
    quality,
    product: product.assetId,
    fidelity: product.fidelity,
    demoOnly: true,
    clips: first.stats,
    transitions,
    reels,
    cache,
    approval:
      "3D clips are PENDING owner approval in the panel (/studio-3d); the DEMO_ONLY reel is never publishable",
  };
  fs.writeFileSync(path.join(out, `summary_${quality}.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ cache, transitions }, null, 1));
  await prisma?.$disconnect();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
