import fs from "node:fs";
import path from "node:path";
import { performanceLevel } from "@cre/analytics";
import { TIER_PLANS, type TierPlan } from "@cre/config";
import { routeGeneration, transitionContent, type JobType } from "@cre/core";
import {
  decimalFieldToMicros,
  microsToDecimal,
  type Asset,
  type AssetKind,
  type AssetOrigin,
  type Brand,
  type ContentProject,
  type Prisma,
  type Product,
  type Scene,
  type TxClient,
} from "@cre/db";
import {
  colorKeyCutout,
  generateProductPackshot,
  generateWhoosh,
  normalizeImage,
  probeMedia,
} from "@cre/media";
import { downloadToFile } from "@cre/providers";
import { BudgetBlockedError, FatalError, idempotencyKey, toJson } from "@cre/shared";
import { assetLocalPath, ensureAssetRow, markAssetReady } from "../assets.ts";
import type { PipelineContext } from "../context.ts";
import { payloadString, type JobExecution } from "../job-types.ts";
import { execContext, runPaidMedia } from "../paid.ts";
import { musicMoodFor } from "../prompt-context.ts";
import { productEvidence } from "../stats.ts";
import { enqueue } from "../outbox.ts";

/** Generated stills are made at ~1 MP (cheapest billing) and upscaled by the compositor. */
export const GENERATED_IMAGE_SIZE = { width: 768, height: 1344 };

const IMAGE_STYLE_SUFFIX =
  ", photorealistic, natural light, vertical 9:16 composition, no text, no watermark, no logos";

export interface DesiredAsset {
  key: string;
  kind: AssetKind;
  origin: AssetOrigin;
  jobType: JobType;
  projectId: string | null;
  brandId: string | null;
  sceneId?: string;
  productId?: string;
  prompt?: string;
  params: Record<string, unknown>;
  dependsOn: string[];
  role: "product_image" | "product_cutout" | "scene_image" | "scene_video" | "voiceover" | "music" | "sfx";
}

export function voiceoverText(scenes: Pick<Scene, "voiceoverText">[]): string {
  return scenes
    .map((s) => (s.voiceoverText ?? "").replace(/\*/g, "").trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Every asset a project needs at its tier, as content-addressed keys (dependencies first).
 * Unchanged inputs ⇒ unchanged keys ⇒ READY assets are reused instead of paid for again.
 */
export function desiredAssets(
  ctx: PipelineContext,
  project: Pick<ContentProject, "id" | "workspaceId" | "brandId" | "voiceRevision">,
  scenes: Scene[],
  brand: Pick<Brand, "id" | "workspaceId" | "ttsEnabled" | "voiceId" | "allowAiVideo" | "niche">,
  product: Pick<Product, "id" | "imageUrls" | "title"> | null,
  plan: TierPlan,
): DesiredAsset[] {
  const out: DesiredAsset[] = [];
  const media = ctx.media;
  if (product) {
    const url = product.imageUrls[0] ?? null;
    const productImage: DesiredAsset = {
      key: idempotencyKey("asset:product_image", {
        productId: product.id,
        url,
        mock: ctx.env.MOCK_MEDIA,
        v: 1,
      }),
      kind: "PRODUCT_IMAGE",
      origin: url && !ctx.env.MOCK_MEDIA ? "PRODUCT_SOURCE" : "PROGRAMMATIC",
      jobType: "asset.product_image",
      projectId: null,
      brandId: brand.id,
      productId: product.id,
      params: { url },
      dependsOn: [],
      role: "product_image",
    };
    out.push(productImage);
    if (plan.backgroundRemoval) {
      out.push({
        key: idempotencyKey("asset:product_cutout", {
          source: productImage.key,
          provider: media.bgRemoval.name,
          model: media.models.bgRemoval,
        }),
        kind: "PRODUCT_CUTOUT",
        origin: "DERIVED",
        jobType: "asset.product_image",
        projectId: null,
        brandId: brand.id,
        productId: product.id,
        params: {},
        dependsOn: [productImage.key],
        role: "product_cutout",
      });
    }
  }

  let imageBudget = plan.maxGeneratedImages;
  let videoBudget = brand.allowAiVideo && plan.videoClass ? plan.aiVideoShots : 0;
  const imageModel = media.models.image[plan.imageClass];
  for (const scene of scenes) {
    const wantsVideo = scene.visualType === "ai_video";
    const wantsImage = scene.visualType === "generated_image" || wantsVideo;
    if (!wantsImage || !scene.imagePrompt || imageBudget <= 0) continue;
    imageBudget--;
    const prompt = `${scene.imagePrompt}${IMAGE_STYLE_SUFFIX}`;
    const image: DesiredAsset = {
      key: idempotencyKey("asset:image", {
        projectId: project.id,
        prompt,
        model: imageModel,
        ...GENERATED_IMAGE_SIZE,
        rev: scene.revision,
      }),
      kind: "IMAGE",
      origin: "GENERATED",
      jobType: "asset.image",
      projectId: project.id,
      brandId: brand.id,
      sceneId: scene.id,
      prompt,
      params: { modelClass: plan.imageClass, model: imageModel, ...GENERATED_IMAGE_SIZE },
      dependsOn: [],
      role: "scene_image",
    };
    out.push(image);
    if (wantsVideo && videoBudget > 0 && plan.videoClass) {
      videoBudget--;
      const videoModel = media.models.video[plan.videoClass];
      out.push({
        key: idempotencyKey("asset:video", {
          image: image.key,
          model: videoModel,
          seconds: plan.aiVideoSecondsPerShot,
          rev: scene.revision,
          w: ctx.render.width,
          h: ctx.render.height,
        }),
        kind: "VIDEO_CLIP",
        origin: "GENERATED",
        jobType: "asset.video",
        projectId: project.id,
        brandId: brand.id,
        sceneId: scene.id,
        prompt: `${scene.imagePrompt}, slow cinematic camera movement`,
        params: { modelClass: plan.videoClass, model: videoModel, seconds: plan.aiVideoSecondsPerShot },
        dependsOn: [image.key],
        role: "scene_video",
      });
    }
  }

  const text = voiceoverText(scenes);
  if (brand.ttsEnabled && text) {
    out.push({
      key: idempotencyKey("asset:voice", {
        projectId: project.id,
        text,
        voice: brand.voiceId,
        provider: media.tts.name,
        rev: project.voiceRevision,
      }),
      kind: "VOICEOVER",
      origin: "GENERATED",
      jobType: "asset.tts",
      projectId: project.id,
      brandId: brand.id,
      prompt: text,
      params: { voice: brand.voiceId },
      dependsOn: [],
      role: "voiceover",
    });
  }
  const totalSec = scenes.reduce((s, sc) => s + sc.durationMs, 0) / 1000;
  const mood = musicMoodFor(brand.niche);
  const bucket = Math.ceil((totalSec + 5) / 10) * 10;
  out.push({
    key: idempotencyKey("asset:music", { brandId: brand.id, mood, seconds: bucket, v: 1 }),
    kind: "MUSIC",
    origin: "PROGRAMMATIC",
    jobType: "asset.music",
    projectId: null,
    brandId: brand.id,
    params: { mood, seconds: bucket },
    dependsOn: [],
    role: "music",
  });
  out.push({
    key: idempotencyKey("asset:sfx", { workspaceId: brand.workspaceId, name: "whoosh", v: 1 }),
    kind: "SFX",
    origin: "PROGRAMMATIC",
    jobType: "asset.music",
    projectId: null,
    brandId: null,
    params: { name: "whoosh" },
    dependsOn: [],
    role: "sfx",
  });
  return out;
}

/* ================================================================== planning (router) ======== */

/** pipeline.plan_assets — choose the generation tier (cost-aware router), then fan out asset jobs. */
export async function planAssetsHandler(exec: JobExecution) {
  const { ctx } = exec;
  const projectId = payloadString(exec, "projectId");
  const project = await ctx.prisma.contentProject.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      brand: true,
      product: true,
      scenes: { orderBy: { index: "asc" } },
      idea: { include: { score: true } },
    },
  });
  if (project.status !== "ASSET_PLANNING") return { skipped: true, status: project.status };
  if (exec.payload.keepTier === true && project.tier) {
    await transitionContent(ctx.prisma, {
      projectId: project.id,
      from: "ASSET_PLANNING",
      to: "GENERATING_ASSETS",
      actor: "WORKER",
      reason: `tier ${project.tier} kept (scoped regeneration)`,
    });
    const kept = await ensureAssets(ctx, project.id, exec.job.runId);
    return { tier: project.tier, kept: true, ...kept };
  }
  const now = ctx.clock.now();
  const media = ctx.media;

  const evidence = await productEvidence(
    ctx.prisma,
    project.brandId,
    project.productId,
    now,
    ctx.env.MOCK_SOCIAL,
  );
  const performance = performanceLevel(evidence);
  const budget = await ctx.guard.getLimits(ctx.prisma, project.workspaceId, project.brandId);
  const check = await ctx.guard.check({
    workspaceId: project.workspaceId,
    brandId: project.brandId,
    projectId: project.id,
    estimatedMicros: 0,
    isMock: false,
  });
  const spend = await ctx.guard.getSpend(ctx.prisma, {
    workspaceId: project.workspaceId,
    brandId: project.brandId,
    projectId: project.id,
    timeZone: project.brand.timezone,
  });

  const text = voiceoverText(project.scenes);
  const genScenes = project.scenes.filter(
    (s) => (s.visualType === "generated_image" || s.visualType === "ai_video") && s.imagePrompt,
  );
  const imgReq = { prompt: "x", width: GENERATED_IMAGE_SIZE.width, height: GENERATED_IMAGE_SIZE.height };
  const decision = routeGeneration({
    format: project.format,
    expectedValueMicros: project.idea?.score
      ? decimalFieldToMicros(project.idea.score.estimatedRevenueUsd)
      : 0,
    performance,
    requestedQuality: project.requestedQuality,
    brand: { maxTier: project.brand.maxTier, allowAiVideo: project.brand.allowAiVideo },
    budget: {
      headroomMicros: check.headroomMicros,
      contentCapMicros: budget.brand?.contentCapMicros ?? null,
      aiVideoCapMicros: budget.brand?.aiVideoCapMicros ?? null,
      spentOnContentMicros: spend.content.total,
    },
    costModel: {
      llmMicros: ctx.llm.estimateCost({ inputTokens: 3000, maxOutputTokens: 1500, calls: 1 }).estimatedMicros,
      imageMicros: (modelClass) => media.image.estimateCost({ ...imgReq, modelClass }).estimatedMicros,
      videoMicros: (modelClass, seconds) =>
        media.video.estimateCost({
          imagePath: "",
          prompt: "x",
          durationSec: seconds,
          width: ctx.render.width,
          height: ctx.render.height,
          fps: ctx.render.fps,
          modelClass,
        }).estimatedMicros,
      ttsMicros: text ? media.tts.estimateCost({ text, language: project.language }).estimatedMicros : 0,
      bgRemovalMicros: media.bgRemoval.estimateCost({ imagePath: "" }).estimatedMicros,
      requestedGeneratedImages: genScenes.length,
      requestedAiShots: project.scenes.filter((s) => s.visualType === "ai_video").length,
      useVoiceover: project.brand.ttsEnabled,
      productImages: project.product ? 1 : 0,
    },
  });
  exec.log.info({ tier: decision.tier, reasons: decision.reasons }, "router decision");
  if (decision.blocked) {
    throw new BudgetBlockedError(
      check.reasons.length
        ? check.reasons
        : [
            {
              scope: "content",
              limit: "content_cap",
              limitValue: budget.brand?.contentCapMicros ?? 0,
              currentValue: spend.content.total,
              requestedValue: decision.estimate.totalMicros,
              message: decision.reasons.at(-1) ?? "budget",
            },
          ],
    );
  }

  await ctx.prisma.$transaction(async (tx) => {
    await transitionContent(tx, {
      projectId: project.id,
      from: "ASSET_PLANNING",
      to: "GENERATING_ASSETS",
      actor: "WORKER",
      reason: `tier ${decision.tier}`,
      data: {
        tier: decision.tier,
        routerDecision: toJson({
          ...decision,
          plan: decision.plan.tier,
          evidence,
          performance,
        }) as Prisma.InputJsonValue,
        costEstimateUsd: microsToDecimal(decision.estimate.totalMicros),
      },
    });
  });
  const result = await ensureAssets(ctx, project.id, exec.job.runId);
  return { tier: decision.tier, estimatedMicros: decision.estimate.totalMicros, ...result };
}

/* ================================================================== fan-out / fan-in ========== */

/** pipeline.assets — create/queue missing assets; when all are READY, move on to rendering. */
export async function ensureAssetsHandler(exec: JobExecution) {
  return ensureAssets(exec.ctx, payloadString(exec, "projectId"), exec.job.runId);
}

export async function ensureAssets(
  ctx: PipelineContext,
  projectId: string,
  runId: string | null,
): Promise<{ desired: number; pending: number; advanced: boolean }> {
  return ctx.prisma.$transaction(
    async (tx: TxClient) => {
      await tx.$queryRaw`SELECT id FROM "ContentProject" WHERE id = ${projectId} FOR UPDATE`;
      const project = await tx.contentProject.findUniqueOrThrow({
        where: { id: projectId },
        include: { brand: true, product: true, scenes: { orderBy: { index: "asc" } } },
      });
      if (project.status !== "GENERATING_ASSETS") return { desired: 0, pending: 0, advanced: false };
      const plan = TIER_PLANS[project.tier ?? "TIER_0"];
      const desired = desiredAssets(ctx, project, project.scenes, project.brand, project.product, plan);
      const ready = new Map<string, Asset>();
      let pending = 0;
      for (const d of desired) {
        let asset = await ensureAssetRow(tx, {
          idempotencyKey: d.key,
          workspaceId: project.workspaceId,
          brandId: d.brandId,
          projectId: d.projectId,
          sceneId: d.sceneId ?? null,
          productId: d.productId ?? null,
          kind: d.kind,
          origin: d.origin,
          prompt: d.prompt ?? null,
          params: d.params,
        });
        if (asset.status === "READY") {
          ready.set(d.key, asset);
          continue;
        }
        pending++;
        if (!d.dependsOn.every((k) => ready.has(k))) continue;
        let jobKey = idempotencyKey("asset-job", { key: d.key });
        if (asset.status === "FAILED") {
          asset = await tx.asset.update({
            where: { id: asset.id },
            data: { status: "PENDING", errorMessage: null },
          });
          jobKey = idempotencyKey("asset-job", { key: d.key, retry: asset.updatedAt.getTime() });
        }
        await enqueue(ctx, tx, {
          type: d.jobType,
          payload: { assetId: asset.id, projectId: project.id },
          idempotencyKey: jobKey,
          workspaceId: project.workspaceId,
          brandId: project.brandId,
          projectId: project.id,
          assetId: asset.id,
          runId,
        });
      }

      // point scenes at their visuals (video clip beats still image)
      for (const scene of project.scenes) {
        const video = desired.find((d) => d.sceneId === scene.id && d.role === "scene_video");
        const image = desired.find((d) => d.sceneId === scene.id && d.role === "scene_image");
        const primary = (video && ready.get(video.key)) ?? (image && ready.get(image.key)) ?? null;
        if ((primary?.id ?? null) !== scene.primaryAssetId) {
          await tx.scene.update({ where: { id: scene.id }, data: { primaryAssetId: primary?.id ?? null } });
        }
      }

      if (pending > 0) return { desired: desired.length, pending, advanced: false };
      await transitionContent(tx, {
        projectId: project.id,
        from: "GENERATING_ASSETS",
        to: "RENDERING",
        actor: "WORKER",
        reason: "all assets ready",
      });
      await enqueue(ctx, tx, {
        type: "pipeline.render",
        payload: { projectId: project.id },
        idempotencyKey: idempotencyKey("render", { projectId: project.id, revision: project.revision }),
        workspaceId: project.workspaceId,
        brandId: project.brandId,
        projectId: project.id,
        runId,
      });
      return { desired: desired.length, pending: 0, advanced: true };
    },
    { timeout: 30_000, maxWait: 15_000 },
  );
}

/** After an asset is READY, re-check every project that may be waiting for it. */
async function fanIn(
  ctx: PipelineContext,
  asset: Asset,
  requesterProjectId: string | null,
  runId: string | null,
): Promise<void> {
  const waiting = await ctx.prisma.contentProject.findMany({
    where: {
      status: "GENERATING_ASSETS",
      workspaceId: asset.workspaceId,
      ...(asset.projectId ? { id: asset.projectId } : asset.brandId ? { brandId: asset.brandId } : {}),
    },
    select: { id: true, revision: true, workspaceId: true, brandId: true },
  });
  const targets = waiting.length ? waiting : [];
  if (requesterProjectId && !targets.some((t) => t.id === requesterProjectId)) {
    const p = await ctx.prisma.contentProject.findUnique({
      where: { id: requesterProjectId },
      select: { id: true, revision: true, workspaceId: true, brandId: true, status: true },
    });
    if (p?.status === "GENERATING_ASSETS") targets.push(p);
  }
  for (const p of targets) {
    await enqueue(ctx, ctx.prisma, {
      type: "pipeline.assets",
      payload: { projectId: p.id },
      idempotencyKey: idempotencyKey("fanin", {
        projectId: p.id,
        revision: p.revision,
        asset: asset.idempotencyKey,
      }),
      workspaceId: p.workspaceId,
      brandId: p.brandId,
      projectId: p.id,
      runId,
    });
  }
}

/* ================================================================== asset jobs ================ */

async function runAssetJob(
  exec: JobExecution,
  generate: (asset: Asset) => Promise<{
    localPath: string;
    mimeType?: string;
    ready: Parameters<typeof markAssetReady>[4];
    after?: (a: Asset) => Promise<void>;
  }>,
) {
  const { ctx } = exec;
  const assetId = payloadString(exec, "assetId");
  const requester = typeof exec.payload.projectId === "string" ? exec.payload.projectId : null;
  const asset = await ctx.prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
  if (asset.status === "READY") {
    await fanIn(ctx, asset, requester, exec.job.runId);
    return { assetId, reused: true };
  }
  await ctx.prisma.asset.update({ where: { id: asset.id }, data: { status: "GENERATING" } });
  try {
    const result = await generate(asset);
    const updated = await markAssetReady(
      ctx,
      ctx.prisma,
      asset,
      result.localPath,
      result.ready,
      result.mimeType,
    );
    await result.after?.(updated);
    await fanIn(ctx, updated, requester, exec.job.runId);
    exec.log.info({ assetId, kind: asset.kind, provider: result.ready.provider }, "asset ready");
    return { assetId, kind: asset.kind, storageKey: updated.storageKey };
  } catch (err) {
    const final =
      exec.attempt >= exec.job.maxAttempts || err instanceof FatalError || err instanceof BudgetBlockedError;
    await ctx.prisma.asset.update({
      where: { id: asset.id },
      data: { status: final ? "FAILED" : "PENDING", errorMessage: (err as Error).message.slice(0, 1000) },
    });
    throw err;
  }
}

function costOf(usageMicros: number | undefined): number | null {
  return usageMicros === undefined ? null : usageMicros;
}

/** asset.image — AI scene still (FLUX / mock gradient). */
export async function imageAssetHandler(exec: JobExecution) {
  const { ctx } = exec;
  return runAssetJob(exec, async (asset) => {
    const project = asset.projectId
      ? await ctx.prisma.contentProject.findUnique({
          where: { id: asset.projectId },
          include: { brand: true },
        })
      : null;
    const params = (asset.params ?? {}) as {
      modelClass?: "cheap" | "standard" | "premium";
      model?: string;
      width?: number;
      height?: number;
    };
    const colors = (project?.brand.colors ?? {}) as { primary?: string; background?: string };
    const req = {
      prompt: asset.prompt ?? "abstract background",
      width: params.width ?? GENERATED_IMAGE_SIZE.width,
      height: params.height ?? GENERATED_IMAGE_SIZE.height,
      modelClass: params.modelClass ?? "cheap",
      ...(params.model ? { model: params.model } : {}),
      seed: parseInt(asset.idempotencyKey.slice(-8), 16) % 2_147_483_647,
      ...(colors.primary && colors.background
        ? { paletteHint: [colors.primary, colors.background] as [string, string] }
        : {}),
    };
    const estimate = ctx.media.image.estimateCost(req);
    const res = await runPaidMedia(
      exec,
      estimate,
      {
        workspaceId: asset.workspaceId,
        brandId: asset.brandId,
        projectId: asset.projectId,
        assetId: asset.id,
        operation: "IMAGE_GENERATION",
        opKey: `image:${asset.idempotencyKey}`,
      },
      () =>
        ctx.media.image.execute(
          req,
          execContext(exec, {
            externalJobId: asset.externalJobId,
            onExternalJobId: async (id) => {
              await ctx.prisma.asset.update({ where: { id: asset.id }, data: { externalJobId: id } });
            },
          }),
        ),
    );
    return {
      localPath: res.filePath,
      mimeType: res.mimeType,
      ready: {
        provider: ctx.media.image.name,
        model: res.model,
        prompt: req.prompt,
        params: { width: req.width, height: req.height, modelClass: req.modelClass },
        seed: res.seed ?? req.seed,
        costMicros: costOf(res.actualCostMicros ?? estimate.estimatedMicros),
        license: res.license,
        isMock: ctx.media.image.isMock,
      },
    };
  });
}

/** asset.video — optional 3-5 s image-to-video shot (only when the router allowed it). */
export async function videoAssetHandler(exec: JobExecution) {
  const { ctx } = exec;
  return runAssetJob(exec, async (asset) => {
    const source = await ctx.prisma.asset.findFirst({
      where: { sceneId: asset.sceneId, kind: "IMAGE", status: "READY", projectId: asset.projectId },
      orderBy: { updatedAt: "desc" },
    });
    if (!source) throw new FatalError("Source image for image-to-video is not ready");
    const params = (asset.params ?? {}) as {
      modelClass?: "cheap" | "standard" | "premium";
      model?: string;
      seconds?: number;
    };
    const req = {
      imagePath: await assetLocalPath(ctx, source),
      prompt: asset.prompt ?? "slow cinematic camera movement",
      durationSec: params.seconds ?? 5,
      width: ctx.render.width,
      height: ctx.render.height,
      fps: ctx.render.fps,
      modelClass: params.modelClass ?? "cheap",
      ...(params.model ? { model: params.model } : {}),
    };
    const estimate = ctx.media.video.estimateCost(req);
    const res = await runPaidMedia(
      exec,
      estimate,
      {
        workspaceId: asset.workspaceId,
        brandId: asset.brandId,
        projectId: asset.projectId,
        assetId: asset.id,
        operation: "VIDEO_GENERATION",
        opKey: `video:${asset.idempotencyKey}`,
      },
      () =>
        ctx.media.video.execute(
          req,
          execContext(exec, {
            externalJobId: asset.externalJobId,
            onExternalJobId: async (id) => {
              await ctx.prisma.asset.update({ where: { id: asset.id }, data: { externalJobId: id } });
            },
          }),
        ),
    );
    return {
      localPath: res.filePath,
      mimeType: res.mimeType,
      ready: {
        provider: ctx.media.video.name,
        model: res.model,
        prompt: req.prompt,
        params: { seconds: req.durationSec, modelClass: req.modelClass },
        costMicros: costOf(res.actualCostMicros ?? estimate.estimatedMicros),
        license: res.license,
        isMock: ctx.media.video.isMock,
        inputs: [{ assetId: source.id, role: "source_image" }],
      },
      after: async () => {
        if (asset.projectId)
          await ctx.prisma.contentProject.update({
            where: { id: asset.projectId },
            data: { aiGenerated: true },
          });
      },
    };
  });
}

/** asset.tts — voice-over for the whole script with word timings for captions. */
export async function ttsAssetHandler(exec: JobExecution) {
  const { ctx } = exec;
  return runAssetJob(exec, async (asset) => {
    const project = await ctx.prisma.contentProject.findUniqueOrThrow({
      where: { id: asset.projectId! },
      include: { brand: true },
    });
    const req = {
      text: asset.prompt ?? "",
      language: project.language,
      ...(project.brand.voiceId ? { voice: project.brand.voiceId } : {}),
    };
    if (!req.text) throw new FatalError("Voice-over text is empty");
    const estimate = ctx.media.tts.estimateCost(req);
    const res = await runPaidMedia(
      exec,
      estimate,
      {
        workspaceId: asset.workspaceId,
        brandId: asset.brandId,
        projectId: asset.projectId,
        assetId: asset.id,
        operation: "TTS",
        opKey: `tts:${asset.idempotencyKey}`,
      },
      () => ctx.media.tts.execute(req, execContext(exec)),
    );
    return {
      localPath: res.filePath,
      mimeType: res.mimeType,
      ready: {
        provider: ctx.media.tts.name,
        model: res.model,
        prompt: req.text,
        params: { voice: res.voice },
        costMicros: costOf(res.actualCostMicros ?? estimate.estimatedMicros),
        license: res.license,
        isMock: ctx.media.tts.isMock,
        metadata: { words: res.words, timingsExact: res.timingsExact, durationMs: res.durationMs },
      },
    };
  });
}

/** asset.music — procedural music bed (MUSIC) or whoosh transition SFX (SFX). Free. */
export async function musicAssetHandler(exec: JobExecution) {
  const { ctx } = exec;
  return runAssetJob(exec, async (asset) => {
    const params = (asset.params ?? {}) as { mood?: "upbeat" | "chill" | "tech"; seconds?: number };
    if (asset.kind === "SFX") {
      const file = path.join(exec.workDir, "whoosh.wav");
      await generateWhoosh(file, exec.signal);
      return {
        localPath: file,
        mimeType: "audio/wav",
        ready: {
          provider: "procedural",
          model: "whoosh-v1",
          license: "procedural (generated)",
          isMock: false,
        },
      };
    }
    const req = {
      durationSec: params.seconds ?? 40,
      mood: params.mood ?? "upbeat",
      seed: asset.brandId ?? asset.idempotencyKey,
    };
    const res = await ctx.media.music.execute(req, execContext(exec));
    return {
      localPath: res.filePath,
      mimeType: res.mimeType,
      ready: {
        provider: ctx.media.music.name,
        model: res.model,
        params: req,
        license: res.license,
        isMock: false,
      },
    };
  });
}

/**
 * asset.product_image — the REAL product photo (downloaded from the product source) or, when none is available
 * (mock mode / missing URL), a clearly-labelled placeholder packshot. PRODUCT_CUTOUT removes the background.
 */
export async function productImageAssetHandler(exec: JobExecution) {
  const { ctx } = exec;
  return runAssetJob(exec, async (asset) => {
    if (!asset.productId) throw new FatalError("Product asset without product");
    const product = await ctx.prisma.product.findUniqueOrThrow({
      where: { id: asset.productId },
      include: { brand: true },
    });
    if (asset.kind === "PRODUCT_CUTOUT") {
      const source = await ctx.prisma.asset.findFirst({
        where: { productId: product.id, kind: "PRODUCT_IMAGE", status: "READY" },
        orderBy: { updatedAt: "desc" },
      });
      if (!source) throw new FatalError("Product image not ready for background removal");
      const sourcePath = await assetLocalPath(ctx, source);
      const info = await probeMedia(sourcePath);
      const hasAlpha = Boolean(info.pixFmt && /rgba|ya8|pal8|yuva/.test(info.pixFmt));
      if (hasAlpha) {
        // already transparent (e.g. placeholder packshot) → no paid call needed
        const out = path.join(exec.workDir, "cutout.png");
        await fs.promises.copyFile(sourcePath, out);
        return {
          localPath: out,
          mimeType: "image/png",
          ready: {
            provider: "passthrough",
            model: "alpha-present",
            license: "derived",
            isMock: false,
            inputs: [{ assetId: source.id, role: "source_image" }],
          },
        };
      }
      const estimate = ctx.media.bgRemoval.estimateCost({ imagePath: sourcePath });
      const res = await runPaidMedia(
        exec,
        estimate,
        {
          workspaceId: asset.workspaceId,
          brandId: asset.brandId,
          projectId: null,
          assetId: asset.id,
          operation: "BACKGROUND_REMOVAL",
          opKey: `bg:${asset.idempotencyKey}`,
        },
        () => ctx.media.bgRemoval.execute({ imagePath: sourcePath }, execContext(exec)),
      ).catch(async (err: unknown) => {
        if (err instanceof BudgetBlockedError) throw err;
        // last resort: free colour-key cutout keeps the pipeline moving
        exec.log.warn({ err: (err as Error).message }, "background removal failed — using colour key");
        const out = path.join(exec.workDir, "cutout-colorkey.png");
        await colorKeyCutout(sourcePath, out);
        return { filePath: out, mimeType: "image/png", model: "colorkey", license: "derived" };
      });
      return {
        localPath: res.filePath,
        mimeType: "image/png",
        ready: {
          provider: ctx.media.bgRemoval.name,
          model: res.model,
          costMicros: estimate.estimatedMicros,
          license: res.license,
          isMock: ctx.media.bgRemoval.isMock,
          inputs: [{ assetId: source.id, role: "source_image" }],
        },
      };
    }

    const url = product.imageUrls[0];
    const colors = (product.brand.colors ?? {}) as { primary?: string; accent?: string };
    if (url && !ctx.env.MOCK_MEDIA) {
      const raw = path.join(exec.workDir, "product-source");
      await downloadToFile("product-source", url, raw, { signal: exec.signal, maxBytes: 25 * 1024 * 1024 });
      const normalized = path.join(exec.workDir, "product.png");
      await normalizeImage(raw, normalized, { maxWidth: 1600, maxHeight: 1600 });
      return {
        localPath: normalized,
        mimeType: "image/png",
        ready: {
          provider: "product-source",
          model: "download",
          sourceUrl: url,
          license: `product-source:${product.source}`,
          isMock: false,
          metadata: { placeholder: false },
        },
        after: async (a) => {
          await ctx.prisma.product.update({ where: { id: product.id }, data: { primaryImageAssetId: a.id } });
        },
      };
    }
    const file = path.join(exec.workDir, "packshot.png");
    await generateProductPackshot(file, {
      title: product.title,
      ...(product.manufacturer ? { subtitle: product.manufacturer } : {}),
      primary: colors.primary ?? "#4F46E5",
      accent: colors.accent ?? "#10B981",
      signal: exec.signal,
    });
    return {
      localPath: file,
      mimeType: "image/png",
      ready: {
        provider: "procedural",
        model: "packshot-placeholder-v1",
        license: "procedural placeholder (replace with a real product photo)",
        isMock: ctx.env.MOCK_MEDIA,
        metadata: { placeholder: true, reason: url ? "mock media mode" : "product has no image URL" },
      },
      after: async (a) => {
        await ctx.prisma.product.update({ where: { id: product.id }, data: { primaryImageAssetId: a.id } });
      },
    };
  });
}
