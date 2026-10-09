/**
 * Record REAL platform metrics for a delivered reel variant (no simulated "learning"):
 *
 *   pnpm reel:outcome --job <jobId> --variant A --locale pl-PL [--platform tiktok] \
 *                     --views 1200 --completion 0.41 --ctr 0.023 --conversions 3 --likes 80 --shares 5
 *
 * Writes a ReelOutcomeSnapshot row and appends the measured outcome to the hook memory, which the hook engine
 * uses (from 3 measured reels per strategy / category / platform / language) to prefer what actually sells.
 */
import { getEnv, loadRootEnvFile } from "@cre/config";
import { createPrismaClient } from "@cre/db";
import { PrismaReelStore } from "@cre/pipeline";
import { HookMemory, ReelOutcome, resolveReelTools, type HookStrategy } from "@cre/reel";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const num = (name: string) => (arg(name) !== undefined ? Number(arg(name)) : undefined);

async function main(): Promise<void> {
  loadRootEnvFile();
  const env = getEnv();
  const jobId = arg("job");
  const variantKey = arg("variant") ?? "A";
  const locale = arg("locale");
  const platform = arg("platform") ?? "tiktok";
  if (!jobId || !locale)
    throw new Error("usage: reel:outcome --job <jobId> --variant A --locale pl-PL --views … --ctr …");
  const outcome = ReelOutcome.parse({
    variantId: `${jobId}-${variantKey}-${locale}`,
    platform,
    collectedAt: new Date().toISOString(),
    ...Object.fromEntries(
      (
        [
          ["views", num("views")],
          ["watchTimeMs", num("watch-ms")],
          ["completionRate", num("completion")],
          ["ctr", num("ctr")],
          ["conversions", num("conversions")],
          ["sales", num("sales")],
          ["likes", num("likes")],
          ["comments", num("comments")],
          ["shares", num("shares")],
        ] as const
      ).filter(([, v]) => v !== undefined),
    ),
  });
  const db = createPrismaClient();
  try {
    const store = new PrismaReelStore(db, null);
    const v = await store.recordOutcome({ jobId, variantKey, locale, platform }, outcome);
    const job = await db.reelJobRecord.findUniqueOrThrow({
      where: { jobId },
      select: { productKey: true, request: true },
    });
    const category = (
      await db.productProfileCache.findFirst({
        where: { productKey: job.productKey },
        orderBy: { createdAt: "desc" },
      })
    )?.profile as { category?: string } | undefined;
    await new HookMemory(resolveReelTools(env).cacheDir).record({
      at: outcome.collectedAt,
      strategy: v.hookStrategy as HookStrategy,
      category: category?.category ?? "other",
      platform,
      locale: v.locale,
      productId: job.productKey,
      variantId: outcome.variantId,
      metrics: {
        ...(outcome.completionRate !== undefined ? { completionRate: outcome.completionRate } : {}),
        ...(outcome.ctr !== undefined ? { ctr: outcome.ctr } : {}),
        ...(outcome.views !== undefined ? { views: outcome.views } : {}),
        ...(outcome.conversions !== undefined && outcome.views
          ? { conversionRate: outcome.conversions / outcome.views }
          : {}),
      },
    });
    console.log(`outcome recorded for ${outcome.variantId} (hook ${v.hookStrategy})`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
