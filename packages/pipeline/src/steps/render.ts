import path from "node:path";
import { TIER_PLANS, VIDEO_DEFAULTS } from "@cre/config";
import { transitionContent, transitionVariant } from "@cre/core";
import { Prisma, type Asset, type Brand, type Scene } from "@cre/db";
import {
  COMPOSITOR_VERSION,
  findLayoutViolations,
  getTemplate,
  layoutStoryboard,
  MotionType,
  renderVideoProject,
  SCENE_RENDERER_VERSION,
  TransitionType,
  type BrandStyle,
  type LayoutViolation,
  type Storyboard,
  type StoryboardScene,
  type StoryboardSceneKind,
  type StoryboardVisual,
  type SubtitleWord,
  type VideoProject,
} from "@cre/media";
import { isSocialPlatform, PLATFORM_LIMITS } from "@cre/publishing";
import { FatalError, idempotencyKey, sha256Hex, stableStringify, toJson } from "@cre/shared";
import { assetLocalPath, ensureAssetRow, markAssetReady } from "../assets.ts";
import type { PipelineContext } from "../context.ts";
import { payloadString, type JobExecution } from "../job-types.ts";
import { formatPrice, isPriceFresh } from "../prompt-context.ts";
import {
  composeCaption,
  ctaButtonText,
  ensureVariantLink,
  planDisclosures,
  resolveLinkTarget,
  variantLinkUrl,
} from "../variants.ts";
import { desiredAssets, type DesiredAsset } from "./assets.ts";
import { captionWithOpening, createExperiment, planExperiment } from "./experiments.ts";
import type { StoredScript } from "./script.ts";
import { enqueue } from "../outbox.ts";

/** Voice-over starts slightly after the first frame so the hook text lands first. */
export const VOICE_START_MS = 300;
const MIN_SCENE_MS = 1600;

export function brandStyle(brand: Pick<Brand, "name" | "colors" | "typography">): BrandStyle {
  const c = (brand.colors ?? {}) as Partial<
    Record<"primary" | "secondary" | "accent" | "text" | "background", string>
  >;
  const t = (brand.typography ?? {}) as { headingFont?: string; bodyFont?: string };
  const hex = (v: string | undefined, d: string) => (v && /^#[0-9a-fA-F]{6}$/.test(v) ? v : d);
  return {
    name: brand.name,
    primary: hex(c.primary, "#4F46E5"),
    secondary: hex(c.secondary, "#1F2937"),
    accent: hex(c.accent, "#10B981"),
    text: hex(c.text, "#FFFFFF"),
    background: hex(c.background, "#0B0B0F"),
    headingFont: t.headingFont ?? "Inter",
    bodyFont: t.bodyFont ?? "Inter",
  };
}

/**
 * Scene durations aligned to the narration: each scene starts just before its first spoken word, so cuts
 * follow the voice-over. Without voice the scripted durations are used.
 */
export function alignSceneDurations(
  scenes: { durationMs: number; voiceText: string | null }[],
  voice: { words: SubtitleWord[]; durationMs: number; startMs: number } | null,
  transitionMs: number,
): number[] {
  if (!voice || voice.words.length === 0) return scenes.map((s) => Math.max(MIN_SCENE_MS, s.durationMs));
  const counts = scenes.map(
    (s) => (s.voiceText ?? "").replace(/\*/g, "").split(/\s+/).filter(Boolean).length,
  );
  const total = counts.reduce((a, b) => a + b, 0);
  const W = voice.words.length;
  const firstWord: (number | null)[] = [];
  let acc = 0;
  for (const c of counts) {
    // exact when tokenisation matches the TTS word list, proportional otherwise
    firstWord.push(
      c > 0 && total > 0 ? Math.min(W - 1, total === W ? acc : Math.round((acc / total) * W)) : null,
    );
    acc += c;
  }
  const starts: number[] = [0];
  for (let i = 1; i < scenes.length; i++) {
    const prev = starts[i - 1]!;
    const fw = firstWord[i];
    const target =
      fw !== null && fw !== undefined
        ? voice.startMs + voice.words[fw]!.startMs - 150
        : prev + scenes[i - 1]!.durationMs;
    starts.push(Math.max(prev + MIN_SCENE_MS, target));
  }
  const voiceEnd = voice.startMs + voice.durationMs;
  return scenes.map((s, i) => {
    if (i < scenes.length - 1) return Math.round(starts[i + 1]! - starts[i]! + transitionMs);
    return Math.round(Math.max(s.durationMs, MIN_SCENE_MS, voiceEnd + 700 - starts[i]!));
  });
}

const STORYBOARD_KINDS = new Set<StoryboardSceneKind>([
  "HOOK",
  "PROBLEM",
  "PRODUCT",
  "AI_SHOT",
  "DEMO",
  "BENEFITS",
  "COMPARISON",
  "OFFER",
  "CTA",
  "GENERIC",
]);
/** Scene kinds that show the real product when no generated visual exists. */
const PRODUCT_FALLBACK_KINDS = new Set(["HOOK", "PRODUCT", "OFFER", "DEMO", "AI_SHOT", "GENERIC"]);

const ref = (a: Pick<Asset, "id">) => `asset:${a.id}`;

interface RenderInputs {
  sceneVisuals: Map<string, Asset>;
  product: Asset | null;
  voice: Asset | null;
  music: Asset | null;
  sfx: Asset | null;
  logo: Asset | null;
  used: { asset: Asset; role: string }[];
  missing: DesiredAsset[];
}

async function collectInputs(
  ctx: PipelineContext,
  desired: DesiredAsset[],
  scenes: Scene[],
  logoAssetId: string | null,
): Promise<RenderInputs> {
  const keys = desired.map((d) => d.key);
  const rows = await ctx.prisma.asset.findMany({ where: { idempotencyKey: { in: keys }, status: "READY" } });
  const byKey = new Map(rows.map((a) => [a.idempotencyKey, a]));
  const pick = (role: DesiredAsset["role"]) =>
    desired
      .filter((d) => d.role === role)
      .map((d) => byKey.get(d.key))
      .find(Boolean) ?? null;
  const sceneVisuals = new Map<string, Asset>();
  for (const s of scenes) {
    const video = desired.find((d) => d.sceneId === s.id && d.role === "scene_video");
    const image = desired.find((d) => d.sceneId === s.id && d.role === "scene_image");
    const chosen = (video && byKey.get(video.key)) ?? (image && byKey.get(image.key));
    if (chosen) sceneVisuals.set(s.id, chosen);
  }
  const logo = logoAssetId
    ? await ctx.prisma.asset.findFirst({ where: { id: logoAssetId, status: "READY" } })
    : null;
  const inputs: RenderInputs = {
    sceneVisuals,
    product: pick("product_cutout") ?? pick("product_image"),
    voice: pick("voiceover"),
    music: pick("music"),
    sfx: pick("sfx"),
    logo,
    used: [],
    missing: desired.filter((d) => !byKey.has(d.key)),
  };
  for (const [, a] of sceneVisuals)
    inputs.used.push({ asset: a, role: a.kind === "VIDEO_CLIP" ? "scene_video" : "scene_image" });
  if (inputs.product)
    inputs.used.push({
      asset: inputs.product,
      role: inputs.product.kind === "PRODUCT_CUTOUT" ? "product_cutout" : "product_image",
    });
  if (inputs.voice) inputs.used.push({ asset: inputs.voice, role: "voiceover" });
  if (inputs.music) inputs.used.push({ asset: inputs.music, role: "music" });
  if (inputs.sfx) inputs.used.push({ asset: inputs.sfx, role: "sfx" });
  if (logo) inputs.used.push({ asset: logo, role: "logo" });
  return inputs;
}

function sceneVisual(scene: Scene, inputs: RenderInputs): StoryboardVisual {
  const motion = MotionType.safeParse(scene.motion);
  const generated = inputs.sceneVisuals.get(scene.id);
  if (generated?.kind === "VIDEO_CLIP") return { type: "video", src: ref(generated) };
  if (generated)
    return { type: "image", src: ref(generated), ...(motion.success ? { motion: motion.data } : {}) };
  if (scene.kind === "CTA" || scene.kind === "BENEFITS" || scene.kind === "COMPARISON")
    return { type: "card" };
  if (inputs.product && (scene.visualType === "product_image" || PRODUCT_FALLBACK_KINDS.has(scene.kind))) {
    return { type: "product", productSrc: ref(inputs.product) };
  }
  return { type: "card" };
}

interface RenderedMaster {
  master: Asset;
  cover: Asset;
  stats: Record<string, unknown>;
  violations: LayoutViolation[];
}

/** Render one VideoProject to RENDERED_VIDEO + THUMBNAIL assets (or reuse an identical earlier render). */
async function renderMaster(
  exec: JobExecution,
  project: { id: string; workspaceId: string; brandId: string; revision: number },
  inputs: RenderInputs,
  videoProject: VideoProject,
  templateKey: string,
  arm: string,
): Promise<RenderedMaster> {
  const { ctx } = exec;
  const sb = { format: videoProject.format };
  const violations = findLayoutViolations(videoProject);
  const specHash = sha256Hex(
    stableStringify({ videoProject, scenes: SCENE_RENDERER_VERSION, compositor: COMPOSITOR_VERSION }),
  ).slice(0, 32);
  const videoKey = idempotencyKey("asset:render", { projectId: project.id, spec: specHash });
  let master = await ensureAssetRow(ctx.prisma, {
    idempotencyKey: videoKey,
    workspaceId: project.workspaceId,
    brandId: project.brandId,
    projectId: project.id,
    kind: "RENDERED_VIDEO",
    origin: "RENDERED",
    params: { templateKey, width: sb.format.width, height: sb.format.height, fps: sb.format.fps, arm },
    revision: project.revision,
  });
  let cover = await ensureAssetRow(ctx.prisma, {
    idempotencyKey: idempotencyKey("asset:cover", { video: videoKey }),
    workspaceId: project.workspaceId,
    brandId: project.brandId,
    projectId: project.id,
    kind: "THUMBNAIL",
    origin: "RENDERED",
    revision: project.revision,
  });
  let renderStats: Record<string, unknown> = { reused: true };
  if (master.status !== "READY" || cover.status !== "READY") {
    const paths = new Map<string, string>();
    for (const u of inputs.used) paths.set(ref(u.asset), await assetLocalPath(ctx, u.asset));
    const outputPath = path.join(exec.workDir, `${arm}-master.mp4`);
    const coverPath = path.join(exec.workDir, `${arm}-cover.jpg`);
    const result = await renderVideoProject(videoProject, {
      resolveSrc: (src) => {
        const p = paths.get(src);
        if (!p) throw new FatalError(`Render input not resolved: ${src}`);
        return p;
      },
      workDir: path.join(exec.workDir, `render-${arm}`),
      cacheDir: path.join(ctx.cacheDir, "scenes"),
      outputPath,
      coverPath,
      signal: exec.signal,
      preset: ctx.render.preset,
      oversample: ctx.render.oversample,
      onProgress: (e) => exec.log.debug(e, "render progress"),
    });
    renderStats = {
      reused: false,
      totalMs: result.totalMs,
      cachedScenes: result.scenes.filter((x) => x.cached).length,
      scenes: result.scenes.length,
    };
    const mockInputs = inputs.used.some((u) => u.asset.isMock);
    master = await markAssetReady(
      ctx,
      ctx.prisma,
      master,
      outputPath,
      {
        provider: "ffmpeg",
        model: `compositor-v${COMPOSITOR_VERSION}.${SCENE_RENDERER_VERSION}`,
        params: {
          templateKey,
          width: sb.format.width,
          height: sb.format.height,
          fps: sb.format.fps,
          specHash,
          arm,
        },
        costMicros: 0,
        license: "composite of the listed input assets",
        isMock: false,
        metadata: {
          layoutViolations: violations,
          render: renderStats,
          mockInputs,
          timelineMs: result.timeline.totalMs,
        },
        inputs: inputs.used.map((u) => ({ assetId: u.asset.id, role: u.role })),
      },
      "video/mp4",
    );
    cover = await markAssetReady(
      ctx,
      ctx.prisma,
      cover,
      coverPath,
      {
        provider: "ffmpeg",
        model: "frame-extract",
        costMicros: 0,
        license: "frame of the master video",
        isMock: false,
        inputs: [{ assetId: master.id, role: "video" }],
      },
      "image/jpeg",
    );
  }
  return { master, cover, stats: renderStats, violations };
}

/** pipeline.render — storyboard → VideoProject (layout engine) → FFmpeg → master video, cover and platform variants. */
export async function renderHandler(exec: JobExecution) {
  const { ctx } = exec;
  const projectId = payloadString(exec, "projectId");
  const project = await ctx.prisma.contentProject.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      brand: { include: { disclosureRules: true } },
      product: true,
      template: true,
      scenes: { orderBy: { index: "asc" } },
      variants: true,
    },
  });
  if (project.status !== "RENDERING") return { skipped: true, status: project.status };
  if (project.scenes.length === 0) throw new FatalError("Project has no scenes to render");
  const now = ctx.clock.now();
  const brand = project.brand;
  const script = (project.script ?? null) as StoredScript | null;
  const plan = TIER_PLANS[project.tier ?? "TIER_0"];
  const desired = desiredAssets(ctx, project, project.scenes, brand, project.product, plan);
  const inputs = await collectInputs(ctx, desired, project.scenes, brand.logoAssetId);
  const requiredMissing = inputs.missing.filter((d) => d.role === "voiceover" || d.role === "product_image");
  if (requiredMissing.length) {
    throw new FatalError(
      `Required assets are not ready: ${requiredMissing.map((d) => d.role).join(", ")} — regenerate assets`,
    );
  }

  // ---- monetisation context: link target and disclosures ------------------------------------------------
  const target = await resolveLinkTarget(ctx.prisma, project);
  const isMonetized = target?.isAffiliate ?? false;
  const aiGenerated =
    project.aiGenerated ||
    inputs.used.some(
      (u) => u.asset.kind === "VIDEO_CLIP" || (u.asset.kind === "IMAGE" && u.asset.origin === "GENERATED"),
    );
  const platforms = brand.targetPlatforms.filter(isSocialPlatform);
  const masterDisclosure = planDisclosures(brand.disclosureRules, null, { isMonetized, aiGenerated });
  const onScreenDisclosure = masterDisclosure.onScreen.slice(0, 2).join(" · ");

  // ---- storyboard ---------------------------------------------------------------------------------------
  const templateKey = project.template?.key ?? brand.defaultTemplateKey;
  const template = getTemplate(templateKey);
  const voiceMeta = (inputs.voice?.metadata ?? null) as {
    words?: SubtitleWord[];
    durationMs?: number;
  } | null;
  const voice =
    inputs.voice && voiceMeta?.words?.length
      ? {
          words: voiceMeta.words,
          durationMs: voiceMeta.durationMs ?? inputs.voice.durationMs ?? 0,
          startMs: VOICE_START_MS,
        }
      : null;
  const durations = alignSceneDurations(
    project.scenes.map((s) => ({ durationMs: s.durationMs, voiceText: s.voiceoverText })),
    voice,
    template.transition.durationMs,
  );
  const scenes: StoryboardScene[] = project.scenes.map((s, i) => {
    const beat = script?.script[i];
    const transition = TransitionType.safeParse(s.transition);
    const kind: StoryboardSceneKind = STORYBOARD_KINDS.has(s.kind) ? s.kind : "GENERIC";
    return {
      id: s.id,
      kind,
      durationMs: durations[i]!,
      ...(s.onScreenText ? { headline: s.onScreenText } : {}),
      ...(beat?.bullets?.length && (kind === "BENEFITS" || kind === "COMPARISON")
        ? { bullets: beat.bullets }
        : {}),
      visual: sceneVisual(s, inputs),
      ...(transition.success && i > 0 ? { transition: transition.data } : {}),
    };
  });
  const showPrice =
    project.product !== null &&
    (project.product.kind === "OWN_PRODUCT" || project.product.kind === "DIGITAL_PRODUCT") &&
    isPriceFresh(project.product, now);
  const sb: Storyboard = {
    templateKey,
    format: { aspect: "9:16", width: ctx.render.width, height: ctx.render.height, fps: ctx.render.fps },
    safeArea: VIDEO_DEFAULTS.safeArea,
    brand: brandStyle(brand),
    scenes,
    cta: {
      headline: project.scenes.at(-1)?.onScreenText ?? project.cta ?? "",
      button: ctaButtonText(project.ctaType, project.cta),
    },
    ...(onScreenDisclosure ? { disclosure: { text: onScreenDisclosure } } : {}),
    ...(showPrice && project.product ? { priceBadge: { text: formatPrice(project.product)! } } : {}),
    ...(project.product ? { productLabel: project.product.title } : {}),
    ...(voice
      ? {
          subtitles: {
            words: voice.words.map((w) => ({
              text: w.text,
              startMs: w.startMs + VOICE_START_MS,
              endMs: w.endMs + VOICE_START_MS,
            })),
          },
        }
      : {}),
    audio: {
      ...(inputs.music ? { musicSrc: ref(inputs.music) } : {}),
      ...(inputs.voice ? { voiceover: { src: ref(inputs.voice), startMs: VOICE_START_MS } } : {}),
      ...(inputs.sfx ? { transitionSfxSrc: ref(inputs.sfx) } : {}),
    },
    ...(inputs.logo ? { logoSrc: ref(inputs.logo) } : {}),
    progressBar: true,
    output: { preset: ctx.render.preset },
  };
  const videoProject: VideoProject = layoutStoryboard(sb);
  const {
    master,
    cover,
    stats: renderStats,
    violations,
  } = await renderMaster(exec, project, inputs, videoProject, templateKey, "A");

  // ---- optional A/B experiment: reuses every asset (hook test = one more final pass, caption test = free) ----
  const experiment = await planExperiment(ctx, project, script, platforms);
  const armB =
    experiment?.variable === "HOOK"
      ? await renderMaster(
          exec,
          project,
          inputs,
          layoutStoryboard({
            ...sb,
            scenes: sb.scenes.map((sc, i) => (i === 0 ? { ...sc, headline: experiment.hook } : sc)),
          }),
          templateKey,
          "B",
        )
      : null;

  // ---- platform variants + state change ----------------------------------------------------------------
  const variantIds: string[] = [];
  await ctx.prisma.$transaction(
    async (tx) => {
      for (const platform of platforms) {
        const existing = project.variants.find((v) => v.platform === platform && v.armKey === "A");
        const variant =
          existing ??
          (await tx.contentVariant.create({
            data: { projectId: project.id, platform, placement: "REEL", status: "PENDING", armKey: "A" },
          }));
        if (variant.status !== "PENDING") continue;
        variantIds.push(variant.id);
        const link = target
          ? await ensureVariantLink(tx, { variant, project, brandSlug: brand.slug, target })
          : null;
        const platformCopy = script?.platformCaptions?.find((c) => c.platform === platform);
        const disclosure = planDisclosures(brand.disclosureRules, platform, { isMonetized, aiGenerated });
        const composed = composeCaption({
          platform,
          body: platformCopy?.caption ?? project.caption ?? project.title,
          hashtags: platformCopy?.hashtags ?? project.hashtags,
          disclosure,
          programDisclosure: target?.programDisclosure ?? null,
          linkUrl: PLATFORM_LIMITS[platform].linkClickable ? variantLinkUrl(ctx.env.APP_URL, link) : null,
        });
        // captions the owner edited are locked until new copy is requested
        const keep =
          Boolean((variant.overrides as { captionLocked?: boolean } | null)?.captionLocked) &&
          Boolean(variant.caption);
        await tx.contentVariant.update({
          where: { id: variant.id },
          data: {
            ...(keep
              ? {}
              : {
                  caption: composed.caption,
                  hashtags: composed.hashtags,
                  firstComment: platformCopy?.firstComment ?? null,
                }),
            disclosureText: composed.disclosureText,
            aiGenerated,
            qaScore: null,
            qaIssues: Prisma.DbNull,
          },
        });
        for (const [role, asset] of [
          ["VIDEO", master],
          ["COVER", cover],
        ] as const) {
          await tx.variantMedia.upsert({
            where: { variantId_role_position: { variantId: variant.id, role, position: 0 } },
            create: { variantId: variant.id, assetId: asset.id, role, position: 0 },
            update: { assetId: asset.id },
          });
        }
      }
      if (experiment) {
        const experimentId = await createExperiment(tx, {
          projectId: project.id,
          plan: experiment,
          hookA: project.hook ?? "",
          styleA: project.hookStyle ?? "original",
        });
        await tx.contentVariant.updateMany({
          where: { projectId: project.id, platform: experiment.platform, armKey: "A" },
          data: { experimentId },
        });
        const variantB =
          project.variants.find((v) => v.platform === experiment.platform && v.armKey === "B") ??
          (await tx.contentVariant.create({
            data: {
              projectId: project.id,
              platform: experiment.platform,
              placement: "REEL",
              status: "PENDING",
              armKey: "B",
              experimentId,
              overrides: toJson({
                hook: experiment.hook,
                hookStyle: experiment.hookStyle,
              }) as Prisma.InputJsonValue,
            },
          }));
        if (variantB.status === "PENDING") {
          variantIds.push(variantB.id);
          const link = target
            ? await ensureVariantLink(tx, { variant: variantB, project, brandSlug: brand.slug, target })
            : null;
          const platformCopy = script?.platformCaptions?.find((c) => c.platform === experiment.platform);
          const composed = composeCaption({
            platform: experiment.platform,
            body: captionWithOpening(
              platformCopy?.caption ?? project.caption ?? project.title,
              experiment.hook,
            ),
            hashtags: platformCopy?.hashtags ?? project.hashtags,
            disclosure: planDisclosures(brand.disclosureRules, experiment.platform, {
              isMonetized,
              aiGenerated,
            }),
            programDisclosure: target?.programDisclosure ?? null,
            linkUrl: PLATFORM_LIMITS[experiment.platform].linkClickable
              ? variantLinkUrl(ctx.env.APP_URL, link)
              : null,
          });
          await tx.contentVariant.update({
            where: { id: variantB.id },
            data: {
              caption: composed.caption,
              hashtags: composed.hashtags,
              firstComment: platformCopy?.firstComment ?? null,
              disclosureText: composed.disclosureText,
              aiGenerated,
              experimentId,
              qaScore: null,
              qaIssues: Prisma.DbNull,
            },
          });
          for (const [role, asset] of [
            ["VIDEO", armB?.master ?? master],
            ["COVER", armB?.cover ?? cover],
          ] as const) {
            await tx.variantMedia.upsert({
              where: { variantId_role_position: { variantId: variantB.id, role, position: 0 } },
              create: { variantId: variantB.id, assetId: asset.id, role, position: 0 },
              update: { assetId: asset.id },
            });
          }
        }
      }
      await transitionContent(tx, {
        projectId: project.id,
        from: "RENDERING",
        to: "QA",
        actor: "WORKER",
        reason: renderStats.reused ? "render reused" : "rendered",
        data: {
          renderSpec: toJson(videoProject) as Prisma.InputJsonValue,
          masterAssetId: master.id,
          coverAssetId: cover.id,
          durationMs: master.durationMs ?? null,
          aiGenerated,
        },
      });
      await enqueue(ctx, tx, {
        type: "pipeline.qa",
        payload: { projectId: project.id },
        idempotencyKey: idempotencyKey("qa", {
          projectId: project.id,
          revision: project.revision,
          video: master.id,
        }),
        workspaceId: project.workspaceId,
        brandId: project.brandId,
        projectId: project.id,
        runId: exec.job.runId,
      });
    },
    { timeout: 30_000 },
  );
  // variants left behind for platforms the brand no longer targets
  for (const v of project.variants.filter(
    (x) => !platforms.includes(x.platform as (typeof platforms)[number]) && x.status === "PENDING",
  )) {
    await transitionVariant(ctx.prisma, { variantId: v.id, from: "PENDING", to: "SKIPPED" });
  }
  exec.log.info(
    {
      masterAssetId: master.id,
      durationMs: master.durationMs,
      violations: violations.length,
      ...renderStats,
    },
    "render complete",
  );
  return {
    masterAssetId: master.id,
    coverAssetId: cover.id,
    durationMs: master.durationMs,
    variants: variantIds.length,
    violations: violations.length,
    ...renderStats,
  };
}
