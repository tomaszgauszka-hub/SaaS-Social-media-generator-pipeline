/**
 * End-to-end MOCK MODE demo — zero spend, nothing posted publicly:
 *   IDEA → RESEARCH → SCRIPT → ASSETS → VIDEO → QA → APPROVAL → SCHEDULE → MOCK PUBLISH → MOCK ANALYTICS → PROFIT
 *
 *   pnpm demo                         Demo Tools brand, one video, full 1080×1920
 *   pnpm demo --brand demo-beauty --count 2 --fast
 *
 * Options: --brand <slug|all>  --count <n>  --fast (540×960 preview render)  --no-approve  --days <n> (simulated
 * days of analytics, default 8). The simulated timeline ends "now", so the dashboard shows a realistic week.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveFromRoot, setEnvForTesting } from "@cre/config";
import { approveContent, kpiSummary, requestIdeation } from "@cre/core";
import { createPrismaClient, decimalFieldToMicros, seedDatabase, setPrisma } from "@cre/db";
import { createPipelineContext, InlineDispatcher, ManualClock } from "@cre/pipeline";
import { addDays, createLogger, formatUsd } from "@cre/shared";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(2)}%`);

async function main() {
  // Hard guarantee: the demo never calls paid providers or real social APIs.
  const env = setEnvForTesting({
    MOCK_AI: "true",
    MOCK_MEDIA: "true",
    MOCK_SOCIAL: "true",
    PUBLISHING_ENABLED: "false",
  });
  const fast = flag("fast");
  const days = Number(arg("days") ?? 8);
  const count = Number(arg("count") ?? 1);
  const brandArg = arg("brand") ?? "demo-tools";
  const logger = createLogger({ service: "demo", level: flag("verbose") ? "info" : "warn" });
  const prisma = createPrismaClient();
  setPrisma(prisma);
  const started = Date.now();
  const end = new Date();
  const clock = new ManualClock(addDays(end, -days));
  const ctx = createPipelineContext({
    env,
    prisma,
    logger,
    clock,
    ...(fast ? { render: { width: 540, height: 960, fps: 24, preset: "ultrafast", oversample: 1 } } : {}),
  });
  const dispatcher = new InlineDispatcher(ctx, {
    onJob: (job, outcome) => {
      const mark = outcome.status === "succeeded" ? "✓" : outcome.status === "skipped" ? "·" : "✗";
      const detail = "error" in outcome ? ` — ${outcome.error.slice(0, 140)}` : "";
      console.log(`   ${mark} ${job.type.padEnd(22)} ${outcome.status}${detail}`);
    },
  });

  console.log(
    "\nContent Revenue Engine — MOCK MODE demo (no paid API calls, nothing is published publicly)\n",
  );
  const seed = await seedDatabase(prisma, {
    ownerEmail: env.SEED_OWNER_EMAIL,
    ownerPassword: env.SEED_OWNER_PASSWORD,
  });
  const slugs = brandArg === "all" ? Object.keys(seed.brandIds) : [brandArg];
  const brandIds = slugs.map((s) => {
    const id = seed.brandIds[s];
    if (!id) throw new Error(`Unknown brand "${s}". Available: ${Object.keys(seed.brandIds).join(", ")}`);
    return id;
  });

  console.log(`1) Ideation + production (simulated date ${clock.now().toISOString().slice(0, 10)})`);
  for (const brandId of brandIds) await requestIdeation(prisma, { brandId, count, now: clock.now() });
  await dispatcher.runUntilIdle({ advanceUpToMs: 15 * 60_000 });

  const ideationJobs = await prisma.generationJob.findMany({
    where: { type: "strategy.ideate", brandId: { in: brandIds }, status: "SUCCEEDED" },
    orderBy: { finishedAt: "desc" },
    take: brandIds.length,
  });
  const projectIds = ideationJobs.flatMap(
    (j) => (j.result as { selectedProjectIds?: string[] } | null)?.selectedProjectIds ?? [],
  );
  const projects = await prisma.contentProject.findMany({
    where: { id: { in: projectIds } },
    include: { brand: true, masterAsset: true, coverAsset: true, variants: true },
  });
  const outDir = resolveFromRoot(".data/demo");
  await fs.promises.mkdir(outDir, { recursive: true });

  console.log("\n2) Results waiting for the owner");
  for (const p of projects) {
    const usage = await prisma.generationUsage.findMany({ where: { projectId: p.id, status: "COMMITTED" } });
    const cost = usage.reduce((s, u) => s + decimalFieldToMicros(u.actualCostUsd ?? u.estimatedCostUsd), 0);
    let videoOut = "";
    if (p.masterAsset?.storageKey) {
      const src = await ctx.media.storage.getLocalPath(p.masterAsset.storageKey);
      videoOut = path.join(outDir, `${p.brand.slug}-${p.id}.mp4`);
      await fs.promises.copyFile(src, videoOut);
      if (p.coverAsset?.storageKey)
        await fs.promises.copyFile(
          await ctx.media.storage.getLocalPath(p.coverAsset.storageKey),
          videoOut.replace(/\.mp4$/, ".jpg"),
        );
    }
    const report = (p.qaReport ?? {}) as { issues?: { severity: string; message: string }[] };
    console.log(`   • [${p.brand.name}] "${p.title}"`);
    console.log(
      `     status ${p.status} · tier ${p.tier ?? "—"} · QA ${p.qaScore ?? "—"}/100 · simulated cost ${formatUsd(cost)} · ${((p.durationMs ?? 0) / 1000).toFixed(1)} s`,
    );
    console.log(`     hook: ${p.hook}`);
    for (const i of (report.issues ?? []).filter((x) => x.severity !== "info").slice(0, 5))
      console.log(`     qa ${i.severity}: ${i.message}`);
    if (videoOut) console.log(`     video: ${path.relative(process.cwd(), videoOut)}`);
  }

  const waiting = projects.filter((p) => p.status === "WAITING_APPROVAL");
  if (flag("no-approve") || waiting.length === 0) {
    console.log(
      waiting.length
        ? "\nStopped before approval (--no-approve). Approve in the dashboard: /approval"
        : "\nNothing reached the approval queue.",
    );
    await prisma.$disconnect();
    return;
  }

  console.log("\n3) Owner approves → automatic scheduling into the brand's slots");
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: env.SEED_OWNER_EMAIL } });
  for (const p of waiting) {
    const { publications } = await approveContent(prisma, {
      projectId: p.id,
      userId: owner.id,
      now: clock.now(),
    });
    for (const pub of publications)
      console.log(
        `   • ${pub.platform.padEnd(9)} scheduled ${pub.scheduledAt.toISOString().replace("T", " ").slice(0, 16)} UTC`,
      );
  }

  console.log(
    `\n4) Fast-forward ${days} simulated days: mock publishing, analytics snapshots, simulated clicks & conversions`,
  );
  await dispatcher.runUntil(end);

  console.log("\n5) Profit view (simulated data, last", days, "days)");
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: seed.workspaceId } });
  for (const brandId of brandIds) {
    const k = await kpiSummary(prisma, {
      workspaceId: workspace.id,
      brandId,
      from: addDays(end, -days - 1),
      to: addDays(end, 1),
      includeSimulated: true,
    });
    const brand = await prisma.brand.findUniqueOrThrow({ where: { id: brandId } });
    console.log(`   ${brand.name}`);
    console.log(
      `     impressions ${k.impressions.toLocaleString("en-US")} · clicks ${k.clicks} (CTR ${pct(k.ctr)}) · conversions ${k.conversions} (CVR ${pct(k.conversionRate)})`,
    );
    console.log(
      `     revenue ${formatUsd(k.revenueMicros)} · generation cost ${formatUsd(k.aiCostMicros)} · profit ${formatUsd(k.profitMicros)} · ROI ${k.roi === null ? "—" : `${(k.roi * 100).toFixed(0)}%`}`,
    );
  }
  const statuses = await prisma.contentProject.findMany({
    where: { id: { in: projectIds } },
    select: { title: true, status: true },
  });
  console.log(`\n   content status: ${statuses.map((s) => s.status).join(", ")}`);
  const profiles = await prisma.brandPerformanceProfile.findMany({
    where: { brandId: { in: brandIds } },
    orderBy: { version: "desc" },
    take: 1,
  });
  if (profiles[0]?.promptText)
    console.log(
      `\n   learning loop (fed into the next prompts):\n${profiles[0].promptText
        .split("\n")
        .map((l) => `     ${l}`)
        .join("\n")}`,
    );
  console.log(
    `\nDone in ${((Date.now() - started) / 1000).toFixed(1)} s. Open the dashboard (pnpm dev) to review everything.\n`,
  );
  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
