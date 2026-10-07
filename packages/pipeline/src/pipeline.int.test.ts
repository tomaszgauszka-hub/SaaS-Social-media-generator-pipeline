import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setEnvForTesting } from "@cre/config";
import {
  approveContent,
  editContentText,
  enqueueJob,
  kpiSummary,
  requestIdeation,
  requestRegeneration,
  saveCredential,
} from "@cre/core";
import { createPrismaClient, decimalFieldToMicros, seedDatabase, type PrismaClient } from "@cre/db";
import { testDatabaseUrl, truncateAll } from "@cre/db/testing";
import { MockSocialPublisher, type SocialPublisher } from "@cre/publishing";
import { addDays, createLogger, FatalError, idempotencyKey, ProviderError } from "@cre/shared";
import { createPipelineContext, ManualClock, type PipelineContext } from "./context.ts";
import { InlineDispatcher } from "./dispatch/inline.ts";
import { runJob } from "./runner.ts";
import { loadSocialCredentials, publisherFor } from "./social.ts";
import { concludeExperiments } from "./steps/experiments.ts";
import { resumeBudgetBlocked } from "./steps/maintenance.ts";

/**
 * MOCK MODE vertical slice against a real PostgreSQL + FFmpeg:
 * IDEA → SCRIPT → ASSETS → VIDEO → QA → APPROVAL → SCHEDULE → MOCK PUBLISH → MOCK ANALYTICS, with zero spend.
 */
let prisma: PrismaClient;
let ctx: PipelineContext;
let clock: ManualClock;
let dispatcher: InlineDispatcher;
let workspaceId: string;
let brands: Record<string, string>;
let ownerId: string;
let tmp: string;
const start = new Date("2026-03-02T09:00:00Z");

/** Counts every call that reaches a "real" publisher. */
function fakeRealPublisher(): SocialPublisher & { calls: number } {
  const mock = new MockSocialPublisher();
  const fake = {
    name: "fake-real",
    isMock: false,
    platforms: mock.platforms,
    calls: 0,
    healthCheck: () => mock.healthCheck(),
    validate: () => [],
    publish: async () => {
      fake.calls++;
      return Promise.reject(new Error("must never be called in tests"));
    },
    getStatus: (ref: { externalPostId?: string | null }) => mock.getStatus(ref),
    getAnalytics: (id: string, c: Parameters<SocialPublisher["getAnalytics"]>[1]) => mock.getAnalytics(id, c),
  };
  return fake;
}

beforeAll(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cre-pipeline-"));
  const env = setEnvForTesting({
    MOCK_AI: "true",
    MOCK_MEDIA: "true",
    MOCK_SOCIAL: "true",
    PUBLISHING_ENABLED: "false",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: path.join(tmp, "storage"),
    WORK_DIR: path.join(tmp, "work"),
  });
  prisma = createPrismaClient({ url: testDatabaseUrl() });
  await truncateAll(prisma);
  const seed = await seedDatabase(prisma, { ownerEmail: "owner@test.local", ownerPassword: "password123" });
  workspaceId = seed.workspaceId;
  brands = seed.brandIds;
  ownerId = seed.ownerId;
  clock = new ManualClock(start);
  ctx = createPipelineContext({
    env,
    prisma,
    clock,
    logger: createLogger({ service: "test", level: "silent" }),
    render: { width: 360, height: 640, fps: 15, preset: "ultrafast", oversample: 1 },
  });
  dispatcher = new InlineDispatcher(ctx);
});

afterAll(async () => {
  await prisma.$disconnect();
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

async function produce(brandSlug: string): Promise<string> {
  const { jobId } = await requestIdeation(prisma, {
    brandId: brands[brandSlug]!,
    count: 1,
    now: clock.now(),
  });
  await dispatcher.runUntilIdle({ advanceUpToMs: 15 * 60_000 });
  const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
  expect(job.status).toBe("SUCCEEDED");
  const ids = (job.result as { selectedProjectIds: string[] }).selectedProjectIds;
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

describe("mock pipeline (database + FFmpeg)", () => {
  let projectId: string;

  it("produces a QA-checked 9:16 video with platform variants, at zero real spend", async () => {
    projectId = await produce("demo-tools");
    const project = await prisma.contentProject.findUniqueOrThrow({
      where: { id: projectId },
      include: {
        masterAsset: true,
        coverAsset: true,
        variants: { include: { trackedLink: true, media: true } },
        scenes: true,
      },
    });
    expect(project.status).toBe("WAITING_APPROVAL");
    expect(project.qaPassed).toBe(true);
    expect(project.qaScore).toBeGreaterThanOrEqual(70);
    expect(project.masterAsset?.status).toBe("READY");
    expect(project.masterAsset?.width).toBe(360);
    expect(project.masterAsset?.height).toBe(640);
    expect(project.masterAsset?.durationMs).toBeGreaterThan(12_000);
    expect(project.coverAsset?.status).toBe("READY");
    expect(project.scenes[0]?.kind).toBe("HOOK");

    // one READY variant per target platform, each with its own tracked link and the disclosure first
    expect(project.variants.map((v) => v.platform).sort()).toEqual(["FACEBOOK", "INSTAGRAM", "TIKTOK"]);
    for (const v of project.variants) {
      expect(v.status).toBe("READY");
      expect(v.trackedLink).not.toBeNull();
      expect(v.caption?.startsWith("#ad · affiliate link")).toBe(true);
      expect(v.media.map((m) => m.role).sort()).toEqual(["COVER", "VIDEO"]);
    }
    // Facebook captions carry the clickable tracking link; IG/TikTok rely on the bio link
    const fb = project.variants.find((v) => v.platform === "FACEBOOK")!;
    expect(fb.caption).toContain(`/go/${fb.trackedLink!.code}`);

    // every paid operation went through the ledger, all simulated, far below the $0.50 target
    const usage = await prisma.generationUsage.findMany({ where: { projectId } });
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.isMock && u.status === "COMMITTED")).toBe(true);
    const total = usage.reduce((s, u) => s + decimalFieldToMicros(u.actualCostUsd ?? u.estimatedCostUsd), 0);
    expect(total).toBeLessThan(500_000);

    // provenance: the rendered video records its inputs
    const inputs = await prisma.assetInput.count({ where: { assetId: project.masterAssetId! } });
    expect(inputs).toBeGreaterThanOrEqual(3);

    // job timeline: START + SUCCESS for every job, COST events for paid ones
    const jobs = await prisma.generationJob.findMany({ where: { projectId }, include: { events: true } });
    expect(jobs.every((j) => j.status === "SUCCEEDED")).toBe(true);
    expect(
      jobs.every(
        (j) => j.events.some((e) => e.type === "START") && j.events.some((e) => e.type === "SUCCESS"),
      ),
    ).toBe(true);
    expect(jobs.some((j) => j.events.some((e) => e.type === "COST"))).toBe(true);
  });

  it("re-delivered and duplicate jobs are no-ops", async () => {
    const research = await prisma.generationJob.findFirstOrThrow({
      where: { projectId, type: "pipeline.research" },
    });
    expect(await runJob(ctx, research.id)).toEqual({ status: "skipped" });

    // a duplicate row for a step the project already passed: handler sees the state and skips
    const dup = await enqueueJob(prisma, {
      type: "pipeline.research",
      payload: { projectId },
      idempotencyKey: idempotencyKey("test-dup", { projectId }),
      projectId,
      runAt: clock.now(),
    });
    const again = await enqueueJob(prisma, {
      type: "pipeline.research",
      payload: { projectId },
      idempotencyKey: idempotencyKey("test-dup", { projectId }),
      projectId,
      runAt: clock.now(),
    });
    expect(again).toEqual({ id: dup.id, created: false });
    const outcome = await runJob(ctx, dup.id);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.status === "succeeded" && outcome.result).toMatchObject({ skipped: true });
    const project = await prisma.contentProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.status).toBe("WAITING_APPROVAL");
  });

  it("approval schedules into brand slots; mock publishing + analytics produce the profit view", async () => {
    const { publications } = await approveContent(prisma, { projectId, userId: ownerId, now: clock.now() });
    expect(publications).toHaveLength(3);
    const mock = ctx.mockPublisher as MockSocialPublisher;
    await dispatcher.runUntil(addDays(clock.now(), 9));

    const pubs = await prisma.publication.findMany({
      where: { variant: { projectId } },
      include: { snapshots: true },
    });
    expect(
      pubs.every((p) => p.status === "PUBLISHED" && p.isMock && p.externalPostId?.startsWith("mock_")),
    ).toBe(true);
    expect(mock.posted).toHaveLength(3);
    for (const p of pubs) expect(p.snapshots.length).toBeGreaterThanOrEqual(5);
    const project = await prisma.contentProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.status).toBe("ANALYTICS_PENDING");

    const kpis = await kpiSummary(prisma, {
      workspaceId,
      brandId: brands["demo-tools"]!,
      from: addDays(start, -1),
      to: addDays(start, 30),
      includeSimulated: true,
    });
    expect(kpis.impressions).toBeGreaterThan(0);
    expect(kpis.clicks).toBeGreaterThan(0);
    expect(kpis.aiCostMicros).toBeGreaterThan(0);
    expect(kpis.profitMicros).toBe(kpis.revenueMicros - kpis.aiCostMicros);
    // simulated data never leaks into real-mode decisions
    const real = await kpiSummary(prisma, {
      workspaceId,
      brandId: brands["demo-tools"]!,
      from: addDays(start, -1),
      to: addDays(start, 30),
      includeSimulated: false,
    });
    expect(real.clicks).toBe(0);
    expect(real.revenueMicros).toBe(0);
    const profile = await prisma.brandPerformanceProfile.findFirst({
      where: { brandId: brands["demo-tools"]! },
    });
    expect(profile?.sampleSize).toBe(3);
  });
});

describe("safety rails", () => {
  it("refuses real publishing while PUBLISHING_ENABLED=false (kill switch)", async () => {
    const real = fakeRealPublisher();
    const guarded = { ...ctx, publishers: { INSTAGRAM: real, FACEBOOK: real, TIKTOK: real } };
    expect(() => publisherFor(guarded, { platform: "INSTAGRAM", isMock: false, handle: "@brand" })).toThrow(
      FatalError,
    );
    expect(publisherFor(guarded, { platform: "INSTAGRAM", isMock: true, handle: "@brand" }).isMock).toBe(
      true,
    );

    // end to end: a "connected" (non-mock) account must not receive the post
    const projectId = await produce("demo-saas");
    await approveContent(prisma, { projectId, userId: ownerId, now: clock.now() });
    await prisma.socialAccount.updateMany({
      where: { brandId: brands["demo-saas"]! },
      data: { isMock: false, status: "CONNECTED" },
    });
    const guardedDispatcher = new InlineDispatcher(guarded);
    await guardedDispatcher.runUntil(addDays(clock.now(), 2));
    expect(real.calls).toBe(0);
    const pubs = await prisma.publication.findMany({ where: { variant: { projectId } } });
    expect(pubs.every((p) => p.status === "SCHEDULED" && p.errorCode === "PUBLISHING_DISABLED")).toBe(true);
    const jobs = await prisma.generationJob.findMany({ where: { projectId, type: "publish.publication" } });
    expect(jobs.every((j) => j.status === "FAILED")).toBe(true);
  });

  it("a rejected token flags the account for reconnecting and is never retried", async () => {
    const brandId = brands["demo-saas"]!;
    const keyB64 = randomBytes(32).toString("base64");
    const credential = await saveCredential(prisma, {
      workspaceId,
      provider: "meta",
      kind: "OAUTH_TOKEN",
      label: "expired test token",
      secret: { accessToken: "EXPIRED-TOKEN" },
      keyB64,
    });
    await prisma.socialAccount.updateMany({
      where: { brandId },
      data: { isMock: false, status: "CONNECTED", credentialId: credential.id },
    });
    let calls = 0;
    const mock = new MockSocialPublisher();
    const rejecting: SocialPublisher = {
      name: "fake-real",
      isMock: false,
      platforms: mock.platforms,
      healthCheck: () => mock.healthCheck(),
      validate: () => [],
      publish: () => {
        calls++;
        return Promise.reject(
          new ProviderError("meta", "Error validating access token: Session has expired (190)", {
            status: 400,
            retryable: false,
            code: "AUTH_EXPIRED",
          }),
        );
      },
      getStatus: (ref) => mock.getStatus(ref),
      getAnalytics: (id, c) => mock.getAnalytics(id, c),
    };
    const authCtx: PipelineContext = {
      ...ctx,
      env: {
        ...ctx.env,
        PUBLISHING_ENABLED: true,
        CREDENTIALS_ENCRYPTION_KEY: keyB64,
        APP_URL: "https://app.example.com",
      },
      publishers: { INSTAGRAM: rejecting, FACEBOOK: rejecting, TIKTOK: rejecting },
    };

    const projectId = await produce("demo-saas");
    await approveContent(prisma, { projectId, userId: ownerId, now: clock.now() });
    await new InlineDispatcher(authCtx).runUntil(addDays(clock.now(), 2));
    const pubs = await prisma.publication.findMany({
      where: { variant: { projectId } },
      include: { socialAccount: true },
    });
    expect(pubs.length).toBeGreaterThan(0);
    expect(pubs.map((p) => [p.status, p.errorCode, p.socialAccount.status])).toEqual(
      pubs.map(() => ["FAILED", "AUTH_EXPIRED", "NEEDS_REAUTH"]),
    );
    expect(calls).toBe(pubs.length); // one attempt each — auth errors are not retried

    // until the owner reconnects, the flagged account fails fast without calling the platform
    await expect(loadSocialCredentials(authCtx, pubs[0]!.socialAccount, rejecting)).rejects.toMatchObject({
      code: "NEEDS_REAUTH",
    });
    expect(calls).toBe(pubs.length);
  });

  it("blocks paid work when a budget would be exceeded — before the provider is called — and resumes later", async () => {
    const brandId = brands["demo-beauty"]!;
    await prisma.budget.update({
      where: { scopeKey: `brand:${brandId}` },
      data: { dailyLimitUsd: "0.000001" },
    });
    let llmCalls = 0;
    const llm = ctx.llm;
    const counting = new Proxy(llm, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop);
        if (typeof value !== "function") return value;
        const fn = value as (...a: unknown[]) => unknown;
        const counted = prop === "generateStructured" || prop === "generateText";
        return (...args: unknown[]) => {
          if (counted) llmCalls++;
          return fn.apply(target, args);
        };
      },
    });
    const budgetCtx = { ...ctx, llm: counting };
    const budgetDispatcher = new InlineDispatcher(budgetCtx);
    const { jobId } = await requestIdeation(prisma, { brandId, count: 1, now: clock.now() });
    await budgetDispatcher.runUntilIdle();
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { events: true },
    });
    expect(job.status).toBe("BUDGET_BLOCKED");
    expect(job.events.some((e) => e.type === "BUDGET_BLOCKED")).toBe(true);
    expect(llmCalls).toBe(0);
    expect(await prisma.generationUsage.count({ where: { jobId } })).toBe(0);

    // budget raised → maintenance re-queues the blocked job and it completes
    await prisma.budget.update({ where: { scopeKey: `brand:${brandId}` }, data: { dailyLimitUsd: "1.00" } });
    await resumeBudgetBlocked(budgetCtx);
    await budgetDispatcher.runUntilIdle({ advanceUpToMs: 15 * 60_000 });
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("SUCCEEDED");
    expect(llmCalls).toBeGreaterThan(0);
  });

  it("hook-only regeneration reuses every asset and keeps the tier; owner caption edits survive re-renders", async () => {
    const project = await prisma.contentProject.findFirstOrThrow({
      where: { brandId: brands["demo-beauty"]!, status: "WAITING_APPROVAL" },
      include: { variants: true },
    });
    const imagesBefore = await prisma.generationUsage.count({
      where: { projectId: project.id, operation: "IMAGE_GENERATION" },
    });
    await requestRegeneration(prisma, {
      projectId: project.id,
      userId: ownerId,
      scope: "HOOK",
      note: "more specific",
      now: clock.now(),
    });
    await dispatcher.runUntilIdle({ advanceUpToMs: 15 * 60_000 });
    const after = await prisma.contentProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.status).toBe("WAITING_APPROVAL");
    expect(after.revision).toBe(project.revision + 1);
    expect(after.tier).toBe(project.tier);
    expect(after.hook).not.toBe(project.hook);
    expect(
      await prisma.generationUsage.count({ where: { projectId: project.id, operation: "IMAGE_GENERATION" } }),
    ).toBe(imagesBefore);
    expect(after.masterAssetId).not.toBe(project.masterAssetId); // re-rendered with the new hook

    // owner edits the on-screen hook and one caption → re-render keeps the edited caption
    const variant = project.variants.find((v) => v.platform === "INSTAGRAM")!;
    const caption =
      "#ad · affiliate link\n\nOwner-written caption that stays exactly like this. Link in bio.";
    await editContentText(prisma, {
      projectId: project.id,
      userId: ownerId,
      hook: "Owner *edited* hook",
      variantCaptions: { [variant.id]: caption },
      now: clock.now(),
    });
    await dispatcher.runUntilIdle({ advanceUpToMs: 15 * 60_000 });
    const edited = await prisma.contentProject.findUniqueOrThrow({
      where: { id: project.id },
      include: { variants: true },
    });
    expect(edited.status).toBe("WAITING_APPROVAL");
    expect(JSON.stringify(edited.renderSpec)).toContain("Owner *edited* hook");
    expect(edited.variants.find((v) => v.id === variant.id)?.caption).toBe(caption);
  });

  it("runs a cheap hook A/B test end to end: extra arm reuses assets, both arms publish, CTR decides", async () => {
    const brandId = brands["demo-beauty"]!;
    await prisma.brand.update({
      where: { id: brandId },
      data: { experimentsEnabled: true, ttsEnabled: false },
    });
    clock.advance(60_000); // a new ideation request (same-instant requests are de-duplicated by design)
    const projectId = await produce("demo-beauty");
    const project = await prisma.contentProject.findUniqueOrThrow({
      where: { id: projectId },
      include: { experiments: true, variants: { include: { media: true } } },
    });
    expect(project.status).toBe("WAITING_APPROVAL");
    expect(project.experiments).toHaveLength(1);
    expect(project.experiments[0]!.variable).toBe("HOOK");
    const platform = project.experiments[0]!.primaryPlatform;
    const armA = project.variants.find((v) => v.platform === platform && v.armKey === "A")!;
    const armB = project.variants.find((v) => v.platform === platform && v.armKey === "B")!;
    expect(armB.status).toBe("READY");
    const video = (v: typeof armA) => v.media.find((m) => m.role === "VIDEO")?.assetId;
    expect(video(armB)).toBeDefined();
    expect(video(armB)).not.toBe(video(armA)); // different on-screen hook → its own (cached-scene) render
    expect(armB.trackedLinkId).not.toBe(armA.trackedLinkId); // per-arm click attribution
    // the B render cost nothing extra: only one set of paid images/LLM calls for the project
    const paid = await prisma.generationUsage.count({ where: { projectId, operation: "IMAGE_GENERATION" } });
    expect(paid).toBeLessThanOrEqual(2);

    const { publications } = await approveContent(prisma, { projectId, userId: ownerId, now: clock.now() });
    expect(publications.length).toBe(project.variants.length);
    await dispatcher.runUntil(addDays(clock.now(), 9));
    expect(await concludeExperiments(ctx, clock.now())).toBe(1);
    const exp = await prisma.experiment.findUniqueOrThrow({ where: { id: project.experiments[0]!.id } });
    expect(exp.status).toBe("CONCLUDED");
    const results = exp.results as { arms: { key: string; impressions: number }[]; method: string };
    expect(results.method).toBe("ctr-compare-v1");
    expect(results.arms.every((a) => a.impressions > 0)).toBe(true);
  });

  it("QA auto-rejects non-compliant content, tries one automatic fix, then leaves it for the owner", async () => {
    const brandId = brands["demo-tools"]!;
    // the product title contains "Cordless": banning it guarantees a blocker the script cannot avoid
    await prisma.brand.update({ where: { id: brandId }, data: { bannedWords: { push: "cordless" } } });
    await prisma.product.updateMany({
      where: { brandId, sku: { not: "DT-DRILL-20V" } },
      data: { status: "PAUSED" },
    });
    const projectId = await produce("demo-tools");
    const project = await prisma.contentProject.findUniqueOrThrow({
      where: { id: projectId },
      include: { approvals: true },
    });
    expect(project.status).toBe("REJECTED");
    expect(project.qaPassed).toBe(false);
    expect(project.regenerationCount).toBe(1);
    const auto = project.approvals.filter((a) => a.decision === "AUTO_REJECTED");
    expect(auto).toHaveLength(2);
    expect(auto[0]!.reasons).toContain("QA_FAILED");
    expect(project.approvals.some((a) => a.decision === "REGENERATE" && a.scope === "SCRIPT")).toBe(true);
  });
});
