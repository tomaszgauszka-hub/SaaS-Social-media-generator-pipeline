/**
 * Batch production for a whole catalog slice — the mass-production entry point.
 *
 *   pnpm reel:batch --node "Table Lamps" --limit 10                     discover ABO products with real 3D models
 *   pnpm reel:batch --ids B075X2FZSM,B07HSLKQ9N                         or name them
 *        --brand assets/brands/homely-finds/brand.json --locales pl-PL:PL,en-US:US,de-DE:DE
 *        --platforms tiktok,instagram_reels,youtube_shorts --tier ECONOMY --duration 12
 *        [--run [--no-db]]    produce here, one product after another (default: enqueue `reel.produce` jobs)
 *        [--dry-run]          only list what would be produced
 *
 * Job ids are deterministic per product + brand + tier + locales + platforms, so re-running a batch never queues
 * the same reel twice (outbox idempotency). Products without a 3D model are skipped: the studio shows the real
 * product, never an invented one.
 */
import fs from "node:fs";
import path from "node:path";
import { getEnv, loadRootEnvFile, resolveFromRoot } from "@cre/config";
import { createPrismaClient } from "@cre/db";
import { enqueueReelProduction, PrismaReelStore } from "@cre/pipeline";
import { createGoogleAI } from "@cre/providers";
import {
  FileReelStore,
  ReelFactory,
  ingestAboProduct,
  loadBrandProfile,
  resolveReelTools,
  type ReelJobInput,
  type ReelStore,
} from "@cre/reel";
import { createLogger, sha256Hex } from "@cre/shared";
import { discoverAboProducts, fetchAboProduct } from "../reel/abo.ts";
import { renderReelReport } from "../reel/report.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  loadRootEnvFile();
  const env = getEnv();
  const logger = createLogger({ service: "reel-batch" });
  const brandArg = arg("brand") ?? "assets/brands/homely-finds/brand.json";
  const brand = loadBrandProfile(brandArg);
  const locales = (arg("locales") ?? "pl-PL:PL,en-US:US,de-DE:DE").split(",").map((s) => {
    const [locale, market] = s.split(":");
    return { locale: locale!, market: market ?? locale!.split("-")[1]! };
  });
  const platforms = (arg("platforms") ?? "tiktok").split(",").filter(Boolean);
  const tier = (arg("tier") ?? "ECONOMY") as "ECONOMY";
  const duration = Number(arg("duration") ?? 12);

  const ids = arg("ids")
    ? arg("ids")!
        .split(",")
        .map((s) => s.trim())
    : (
        await discoverAboProducts({
          nodeContains: arg("node") ?? "Table Lamps",
          limit: Number(arg("limit") ?? 5),
        })
      ).map((c) => c.itemId);
  console.log(
    `batch: ${ids.length} product(s) · ${locales.length} locale(s) · ${platforms.length} platform(s) · ${tier}`,
  );
  if (flag("dry-run")) {
    for (const id of ids) console.log(`  - ${id}`);
    return;
  }

  const db = flag("run") && flag("no-db") ? null : createPrismaClient();
  const ws = db
    ? await db.workspace.findFirst({ select: { id: true }, orderBy: { createdAt: "asc" } })
    : null;
  const store: ReelStore = db
    ? new PrismaReelStore(db, ws?.id ?? null)
    : new FileReelStore(resolveReelTools(env).outputDir);
  const googleAI =
    env.GOOGLE_API_KEY || env.GOOGLE_CLOUD_ACCESS_TOKEN ? createGoogleAI(env, { logger }) : null;
  const factory = new ReelFactory({ env, store, logger, googleAI });
  const summary: string[] = [];
  try {
    for (const id of ids) {
      const fetched = await fetchAboProduct(id);
      if (!fetched.hasModel) {
        summary.push(`- ${id}: skipped (no 3D model)`);
        continue;
      }
      const key = sha256Hex(
        JSON.stringify({ id, brand: brand.brandId, tier, locales, platforms, duration }),
      ).slice(0, 10);
      const job: ReelJobInput = {
        jobId: `batch-${id}-${key}`,
        productId: id,
        brandId: brand.brandId,
        platform: platforms[0] as "tiktok",
        extraPlatforms: platforms.slice(1) as "tiktok"[],
        locales,
        targetDurationS: duration,
        tier,
      };
      if (!flag("run")) {
        const rel = (p: string) => path.relative(resolveFromRoot("."), resolveFromRoot(p));
        const out = await enqueueReelProduction(db!, {
          job,
          product: { kind: "abo", path: rel(fetched.dir) },
          brandPath: rel(brandArg),
          workspaceId: ws?.id ?? null,
        });
        summary.push(`- ${id}: ${out.created ? "queued" : "already queued"} (${job.jobId})`);
        continue;
      }
      const started = Date.now();
      const result = await factory.produce({ job, source: await ingestAboProduct(fetched.dir), brand });
      const outDir = path.join(resolveReelTools(env).outputDir, job.jobId);
      fs.writeFileSync(
        path.join(outDir, "report.md"),
        renderReelReport(result, Date.now() - started, googleAI !== null),
      );
      summary.push(
        `- ${id}: ${result.variants.length} reel(s), QA ${result.variants.map((v) => Math.round(v.manifest.qa.score)).join("/")}, ` +
          `$${result.economics.perReelUsd.toFixed(4)} per reel, ${((Date.now() - started) / 1000).toFixed(0)} s`,
      );
    }
  } finally {
    await db?.$disconnect();
  }
  console.log(summary.join("\n"));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
