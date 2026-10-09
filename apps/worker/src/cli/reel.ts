/**
 * Sales reel factory — produce a reel (+ localized / A/B variants) for one real product, end to end, locally.
 *
 *   pnpm reel --product .data/products/abo/B075X2FZSM --brand assets/brands/homely-finds/brand.json \
 *             --locales pl-PL:PL,en-US:US,de-DE:DE --tier STANDARD --duration 12 --platform tiktok
 *   options:  --job-id <id>  --max-cost 0.20  --ab problem_hook,visual_surprise  --no-db  --allow-generative-video
 *             --enqueue   create a `reel.produce` outbox job instead of producing in this process (worker runs it)
 *             --platforms tiktok,instagram_reels,youtube_shorts   one render, every platform (first = primary)
 *             --ab-mode copy|full   A/B arms reuse the master ("copy", default) or get their own shots ("full")
 *             --commission-rate 0.04 | --commission-usd 2.5   payback estimate (break-even sales)
 *
 * Missing API keys are not an error: every capability falls back along its chain (template director, Piper TTS,
 * local music, local SFX, deterministic QA) and the manifest says so. Outputs: REEL_OUTPUT_DIR/<jobId>/.
 */
import fs from "node:fs";
import path from "node:path";
import { getEnv, loadRootEnvFile, resolveFromRoot } from "@cre/config";
import { createPrismaClient } from "@cre/db";
import { runFfmpeg } from "@cre/media";
import { createGoogleAI } from "@cre/providers";
import {
  FileReelStore,
  ReelFactory,
  ingestAboProduct,
  loadBrandProfile,
  loadProductSourceJson,
  resolveReelTools,
  type ReelStore,
} from "@cre/reel";
import { createLogger } from "@cre/shared";
import { enqueueReelProduction, PrismaReelStore } from "@cre/pipeline";
import { renderReelReport } from "../reel/report.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  loadRootEnvFile();
  const env = getEnv();
  const productArg = arg("product") ?? ".data/products/abo/B075X2FZSM";
  const brandArg = arg("brand") ?? "assets/brands/homely-finds/brand.json";
  const locales = (arg("locales") ?? "pl-PL:PL,en-US:US,de-DE:DE").split(",").map((s) => {
    const [locale, market] = s.split(":");
    return { locale: locale!, market: market ?? locale!.split("-")[1]! };
  });
  const productPath = resolveFromRoot(productArg);
  const source = fs.statSync(productPath).isDirectory()
    ? await ingestAboProduct(productPath)
    : loadProductSourceJson(productPath);
  const brand = loadBrandProfile(brandArg);
  const jobId =
    arg("job-id") ?? `reel-${source.id}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
  const logger = createLogger({ service: "reel" });
  const maxCost = arg("max-cost");
  const platforms = (arg("platforms") ?? arg("platform") ?? "tiktok").split(",").filter(Boolean);
  const ab = arg("ab");
  const job = {
    jobId,
    productId: source.id,
    brandId: brand.brandId,
    platform: (platforms[0] ?? "tiktok") as "tiktok",
    extraPlatforms: platforms.slice(1) as "tiktok"[],
    abMode: (arg("ab-mode") ?? "copy") as "copy",
    economics: {
      ...(arg("commission-rate") ? { commissionRate: Number(arg("commission-rate")) } : {}),
      ...(arg("commission-usd") ? { commissionUsd: Number(arg("commission-usd")) } : {}),
    },
    locales,
    targetDurationS: Number(arg("duration") ?? 12),
    tier: (arg("tier") ?? "STANDARD") as "STANDARD",
    ...(maxCost ? { maxApiCost: Number(maxCost) } : {}),
    ...(ab ? { abHooks: ab.split(",") as never } : {}),
    allowGenerativeVideo: flag("allow-generative-video"),
  };

  if (flag("enqueue")) {
    const db = createPrismaClient();
    const ws = await db.workspace.findFirst({ select: { id: true }, orderBy: { createdAt: "asc" } });
    const rel = (p: string) => path.relative(resolveFromRoot("."), resolveFromRoot(p));
    const out = await enqueueReelProduction(db, {
      job,
      product: { kind: fs.statSync(productPath).isDirectory() ? "abo" : "json", path: rel(productArg) },
      brandPath: rel(brandArg),
      workspaceId: ws?.id ?? null,
    });
    console.log(`${out.created ? "enqueued" : "already queued"} reel.produce job ${out.id} (${jobId})`);
    await db.$disconnect();
    return;
  }

  let store: ReelStore;
  let disconnect = async () => {};
  if (flag("no-db")) store = new FileReelStore(resolveReelTools(env).outputDir);
  else {
    const db = createPrismaClient();
    const ws = await db.workspace.findFirst({ select: { id: true }, orderBy: { createdAt: "asc" } });
    store = new PrismaReelStore(db, ws?.id ?? null);
    disconnect = async () => db.$disconnect();
  }
  const googleAI =
    env.GOOGLE_API_KEY || env.GOOGLE_CLOUD_ACCESS_TOKEN ? createGoogleAI(env, { logger }) : null;
  const factory = new ReelFactory({ env, store, logger, googleAI });

  const started = Date.now();
  const result = await factory.produce({ job, source, brand });
  const wallMs = Date.now() - started;
  // contact sheet per variant: the 5 representative QA frames (10/30/50/70/90 %) side by side
  for (const v of result.variants) {
    const frames = v.manifest.qa.frames.map((f) => f.path).filter((f) => fs.existsSync(f));
    if (frames.length < 2) continue;
    await runFfmpeg([
      ...frames.flatMap((f) => ["-i", f]),
      "-filter_complex",
      `${frames.map((_, i) => `[${i}:v]scale=324:576[f${i}]`).join(";")};${frames.map((_, i) => `[f${i}]`).join("")}hstack=inputs=${frames.length}`,
      "-q:v",
      "3",
      path.join(path.dirname(v.video), `${v.variantId}.sheet.jpg`),
    ]).catch((e: unknown) => logger.warn({ err: String(e) }, "contact sheet failed"));
  }
  const report = renderReelReport(result, wallMs, googleAI !== null);
  const outDir = path.join(resolveReelTools(env).outputDir, jobId);
  fs.writeFileSync(path.join(outDir, "report.md"), report);
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ ...result, wallMs }, null, 1));
  console.log(report);
  await disconnect();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
