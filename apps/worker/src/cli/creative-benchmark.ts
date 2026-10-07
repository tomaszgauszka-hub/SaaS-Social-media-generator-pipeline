/**
 * Creative Engine V2 benchmark (spec §73–§76, checkpoint 1): renders the six DEMO_ONLY benchmark reels locally
 * and runs every quality layer on them.
 *
 *   pnpm creative:benchmark                       all six reels → DB + storage + .data/benchmark/report.{json,md}
 *   pnpm creative:benchmark --only bench-tools-drill,bench-pet-grooming-kit
 *   pnpm creative:benchmark --no-db               files and report only
 *
 * Zero AI calls, zero external generation: brief → deterministic director → measured render plan → Remotion
 * (local Chromium) → synthesised audio → FFmpeg loudness + mux → technical / creative / factual / compliance /
 * localization QA. Demo media is labelled on screen and the renders are never PRODUCTION READY.
 */
import fs from "node:fs";
import path from "node:path";
import { getEnv, resolveFromRoot } from "@cre/config";
import {
  DIRECTOR_VERSION,
  complianceQa,
  creativeQa,
  evaluateGates,
  factualQa,
  localizationQa,
  type QualityVerdict,
} from "@cre/creative";
import { BENCHMARK_BRIEFS } from "@cre/creative/benchmark";
import { prepareCreative } from "@cre/creative/node";
import { createPrismaClient, setPrisma, type PrismaClient } from "@cre/db";
import { getRenderEnv, renderFinishedReel, technicalQa } from "@cre/motion";
import { assetStorageKey, createStorageProvider } from "@cre/providers";

const RENDERER_VERSION = "remotion-4.0.534/motion-v1";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

interface ReelSummary {
  id: string;
  title: string;
  category: string;
  structure: string;
  kit: string;
  durationS: number;
  beats: number;
  technical: string;
  technicalWarnings: string[];
  creativeScore: number;
  creativeHardFails: string[];
  factual: number;
  compliance: string;
  localization: number;
  renderS: number;
  renderFps: number;
  audioS: number;
  finishS: number;
  qaS: number;
  loudnessLufs: number | null;
  truePeakDb: number | null;
  sizeMb: number;
  aiTokens: number;
  externalCostUsd: number;
  verdict: QualityVerdict["label"];
  file: string;
  poster: string;
  renderId?: string;
}

async function storeRender(
  prisma: PrismaClient,
  workspaceId: string,
  file: string,
  poster: string,
  hashKey: string,
) {
  const storage = createStorageProvider(getEnv());
  const out: { videoAssetId: string; posterAssetId: string } = { videoAssetId: "", posterAssetId: "" };
  for (const [kind, local, ext, mime] of [
    ["RENDERED_VIDEO", file, "mp4", "video/mp4"],
    ["THUMBNAIL", poster, "jpg", "image/jpeg"],
  ] as const) {
    const idempotencyKey = `creative-benchmark:${hashKey}:${kind}`;
    const asset = await prisma.asset.upsert({
      where: { idempotencyKey },
      create: {
        workspaceId,
        kind,
        origin: "RENDERED",
        status: "PENDING",
        idempotencyKey,
        provider: "local-remotion",
        license: "own · DEMO ONLY",
        metadata: { benchmark: true, demoOnly: true },
      },
      update: {},
    });
    const key = assetStorageKey({ workspaceId, assetId: asset.id, ext });
    const stored = await storage.putFile(key, local, mime);
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
    if (kind === "RENDERED_VIDEO") out.videoAssetId = asset.id;
    else out.posterAssetId = asset.id;
  }
  return out;
}

async function main() {
  const only = arg("only")?.split(",");
  const useDb = !flag("no-db");
  const outDir = resolveFromRoot(arg("out") ?? ".data/benchmark");
  fs.mkdirSync(outDir, { recursive: true });
  const briefs = BENCHMARK_BRIEFS.filter((b) => !only || only.includes(b.id));
  let prisma: PrismaClient | null = null;
  let workspaceId: string | null = null;
  if (useDb) {
    prisma = createPrismaClient();
    setPrisma(prisma);
    const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
    if (!ws) throw new Error("No workspace — run `pnpm db:seed` first (or pass --no-db)");
    workspaceId = ws.id;
  }

  const env = await getRenderEnv();
  console.log(
    `Remotion bundle ${env.bundleCached ? "cached" : `built in ${(env.bundleMs / 1000).toFixed(1)} s`} · Chromium ${env.browserExecutable ?? "(Remotion default)"} · ${env.concurrency} tabs`,
  );
  const reels: ReelSummary[] = [];
  for (const brief of briefs) {
    const t0 = Date.now();
    const prepared = prepareCreative(brief);
    const { plan, storyboard } = prepared;
    process.stdout.write(
      `▶ ${brief.id}: ${plan.beats.length} beats, ${(plan.durationMs / 1000).toFixed(1)} s … `,
    );
    const finished = await renderFinishedReel(plan, outDir);
    const q0 = Date.now();
    const { report: technical } = await technicalQa(finished.file, plan);
    const creative = creativeQa({ storyboard, plan, resolveIssues: prepared.issues, technical });
    const factual = factualQa({ brief: prepared.brief, pack: prepared.localePack, plan });
    const compliance = complianceQa({
      storyboard,
      plan,
      pack: prepared.localePack,
      affiliate: Boolean(prepared.brief.disclosure),
    });
    const localization = localizationQa({
      storyboard,
      pack: prepared.localePack,
      resolveIssues: prepared.issues,
    });
    const verdict = evaluateGates({
      technical,
      creative,
      factual,
      compliance,
      localization,
      flags: storyboard.flags,
    });
    const qaMs = Date.now() - q0;
    const summary: ReelSummary = {
      id: brief.id,
      title: storyboard.title,
      category: storyboard.category,
      structure: storyboard.structure,
      kit: storyboard.style.kit,
      durationS: finished.info.durationMs / 1000,
      beats: plan.beats.length,
      technical: technical.status,
      technicalWarnings: technical.checks
        .filter((c) => c.status !== "pass")
        .map((c) => `${c.label}: ${c.value ?? ""}`),
      creativeScore: creative.score,
      creativeHardFails: creative.hardFails,
      factual: factual.score,
      compliance: compliance.status,
      localization: localization.score,
      renderS: finished.renderMs / 1000,
      renderFps: finished.renderFps,
      audioS: finished.audioMs / 1000,
      finishS: finished.finishMs / 1000,
      qaS: qaMs / 1000,
      loudnessLufs: technical.metrics.integratedLufs,
      truePeakDb: technical.metrics.truePeakDb,
      sizeMb: finished.info.sizeBytes / 1024 / 1024,
      aiTokens: 0,
      externalCostUsd: 0,
      verdict: verdict.label,
      file: path.relative(resolveFromRoot("."), finished.file),
      poster: path.relative(resolveFromRoot("."), finished.poster),
    };
    if (prisma && workspaceId) {
      const assets = await storeRender(
        prisma,
        workspaceId,
        finished.file,
        finished.poster,
        `${prepared.storyboardHash.slice(0, 16)}:${prepared.planHash.slice(0, 16)}`,
      );
      const row = await prisma.creativeRender.create({
        data: {
          workspaceId,
          storyboardId: storyboard.id,
          title: storyboard.title,
          category: storyboard.category,
          structure: storyboard.structure,
          styleKit: storyboard.style.kit,
          locale: plan.locale,
          benchmark: true,
          demoOnly: storyboard.flags.demoOnly,
          placeholderMedia: storyboard.flags.placeholderMedia,
          durationMs: finished.info.durationMs,
          beatCount: plan.beats.length,
          width: plan.format.width,
          height: plan.format.height,
          fps: plan.format.fps,
          storyboardHash: prepared.storyboardHash,
          planHash: prepared.planHash,
          videoAssetId: assets.videoAssetId,
          posterAssetId: assets.posterAssetId,
          renderMs: finished.renderMs,
          audioMs: finished.audioMs,
          finishMs: finished.finishMs,
          qaMs,
          renderFps: finished.renderFps,
          aiTokens: 0,
          aiCostUsd: 0,
          externalCostUsd: 0,
          rendererVersion: RENDERER_VERSION,
          directorVersion: DIRECTOR_VERSION,
          technicalStatus: technical.status,
          technicalReport: JSON.parse(JSON.stringify(technical)) as object,
          storyboard: JSON.parse(JSON.stringify(storyboard)) as object,
          productionReady: verdict.productionReady,
          verdictLabel: verdict.label,
          verdict: JSON.parse(JSON.stringify(verdict)) as object,
          qualityScores: {
            create: [
              {
                kind: "TECHNICAL",
                score: technical.status === "PASS" ? 100 : 0,
                passed: technical.status === "PASS",
                required: "PASS",
                report: JSON.parse(JSON.stringify(technical.checks)) as object,
              },
              {
                kind: "CREATIVE",
                score: creative.score,
                passed: verdict.gates.find((g) => g.gate === "creative")!.pass,
                required: verdict.gates.find((g) => g.gate === "creative")!.required,
                report: JSON.parse(JSON.stringify(creative)) as object,
              },
              {
                kind: "FACTUAL",
                score: factual.score,
                passed: verdict.gates.find((g) => g.gate === "factual")!.pass,
                required: verdict.gates.find((g) => g.gate === "factual")!.required,
                report: JSON.parse(JSON.stringify(factual)) as object,
              },
              {
                kind: "COMPLIANCE",
                score: compliance.score,
                passed: compliance.status === "PASS",
                required: "PASS",
                report: JSON.parse(JSON.stringify(compliance)) as object,
              },
              {
                kind: "LOCALIZATION",
                score: localization.score,
                passed: verdict.gates.find((g) => g.gate === "localization")!.pass,
                required: verdict.gates.find((g) => g.gate === "localization")!.required,
                report: JSON.parse(JSON.stringify(localization)) as object,
              },
            ],
          },
        },
      });
      summary.renderId = row.id;
    }
    reels.push(summary);
    console.log(
      `${summary.durationS.toFixed(1)} s · tech ${summary.technical} · creative ${summary.creativeScore} · render ${summary.renderS.toFixed(0)} s (${summary.renderFps.toFixed(1)} fps) · total ${((Date.now() - t0) / 1000).toFixed(0)} s`,
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    renderer: RENDERER_VERSION,
    director: DIRECTOR_VERSION,
    aiTokensTotal: 0,
    externalCostUsdTotal: 0,
    reels,
  };
  fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const md = [
    "| Reel | Structure | Duration | Beats | Technical QA | Creative QA | Factual | Compliance | Render time | AI tokens | External cost | Verdict |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...reels.map(
      (r) =>
        `| ${r.title} | ${r.structure} | ${r.durationS.toFixed(1)} s | ${r.beats} | ${r.technical}${r.technicalWarnings.length ? ` (${r.technicalWarnings.length} warn)` : ""} | ${r.creativeScore}/100 | ${r.factual} | ${r.compliance} | ${r.renderS.toFixed(0)} s | ${r.aiTokens} | $${r.externalCostUsd.toFixed(2)} | ${r.verdict} |`,
    ),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "report.md"), `${md}\n`);
  console.log(`\n${md}\n\nReport: ${path.join(outDir, "report.json")}`);
  await prisma?.$disconnect();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
