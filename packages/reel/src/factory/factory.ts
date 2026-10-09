/*
 * ReelFactory — the automatic sales-reel production line (no agent, no manual step at runtime).
 *
 *   ProductSource → ProductProfile (cached) → AssetRetriever → ReelDirector → ReelPlan (master copy)
 *     → Blender studio (cached per shot) → MASTER video (language-, platform- and brand-free)
 *     → music (cache | Lyria | local) + SFX (cache → local → API)
 *     → per A/B arm: a new plan ("full") or the same plan re-hooked ("copy": same master, ≈ free)
 *       → per locale: transcreation → claim validation → voice → word timings
 *         → per platform: captions + text layout + logo → ReelComposer localized pass → QA (+ retry) → manifest
 *
 * Every paid call goes through a capability chain + the job's BudgetGate; every step records time and cost.
 * A model only ever returns validated data — this file turns that data into files through local code.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { Env } from "@cre/config";
import { FileFontMeasurer } from "@cre/creative/node";
import type { GoogleAI } from "@cre/providers";
import { sha256Hex, stableStringify, type Logger } from "@cre/shared";
import { buildCaptionTrack, buildSfxCues, buildVoiceTrack, fitMusicToTimeline } from "../audio/index.ts";
import { runChain, type ChainOutcome } from "../capabilities/chain.ts";
import type {
  CallContext,
  DirectorInput,
  DirectorProvider,
  ProviderBase,
  TranscreationProvider,
} from "../capabilities/types.ts";
import { checkRenderedColors, validateCopy } from "../claims/index.ts";
import { composeLocalized, composeMaster, type MasterVideo } from "../composer/index.ts";
import {
  HOOK_STRATEGIES,
  MUSIC_GENRES,
  MUSIC_MOODS,
  SFX_KINDS,
  SHOT_PRESETS,
  STUDIO_ENVIRONMENTS,
  type Capability,
  type HookStrategy,
} from "../contracts/ids.ts";
import { ReelJob, type ReelJobInput } from "../contracts/job.ts";
import type { FallbackRecord, QaReport, ReelManifest } from "../contracts/manifest.ts";
import type { MusicTrack, SfxCueFile, ShotClip, VoiceTrack } from "../contracts/media.ts";
import type { LocaleCopy, ReelPlan } from "../contracts/plan.ts";
import type { ProductProfile, ProductSource } from "../contracts/product.ts";
import {
  PLATFORM_PROFILES,
  TIER_PROFILES,
  type BrandProfile,
  type PlatformProfile,
  type TierProfile,
} from "../contracts/profiles.ts";
import { BudgetGate, CostTracker } from "../cost/tracker.ts";
import {
  compilePlan,
  detectConcepts,
  HookMemory,
  rehookPlan,
  type CategoryKey,
  type HookContext,
} from "../director/index.ts";
import { planRetry, runReelQa } from "../qa/index.ts";
import { AssetIndex, AssetRetriever, type Retrieved } from "../retrieval/index.ts";
import { produceShotClips } from "../studio/index.ts";
import { resolveReelTools, type ReelTools } from "../util/tools.ts";
import {
  applyGenerativeVideoDecisions,
  decideGenerativeVideo,
  type GenerativeVideoDecision,
} from "./generative-video.ts";
import { buildTextElements } from "./layout.ts";
import { buildManifest, type ServedProviders } from "./manifest.ts";
import { buildRegistry, type ProviderRegistry } from "./registry.ts";
import type { ReelStore } from "./store.ts";

export const FACTORY_VERSION = "reel-factory/1";

export interface FactoryDeps {
  env: Env;
  store: ReelStore;
  logger: Logger;
  /** shared Google client (null = no Google provider is even constructed) */
  googleAI: GoogleAI | null;
  tools?: ReelTools;
  now?: () => Date;
}

export interface ProduceInput {
  job: ReelJobInput;
  source: ProductSource;
  brand: BrandProfile;
}

export interface VariantResult {
  variantId: string;
  variantKey: string;
  locale: string;
  platform: string;
  video: string;
  poster: string;
  manifestPath: string;
  planPath: string;
  manifest: ReelManifest;
}

/** What a job cost and when it pays back (estimates; real revenue comes from outcomes). */
export interface UnitEconomics {
  reels: number;
  apiUsd: number;
  computeHours: number;
  computeUsd: number;
  totalUsd: number;
  perReelUsd: number;
  /** commission earned per sale, when known */
  commissionPerSaleUsd?: number;
  /** sales needed to pay back the whole job */
  breakEvenSales?: number;
}

export interface ProduceResult {
  jobId: string;
  variants: VariantResult[];
  totalApiCostUsd: number;
  /** wall time per stage over the whole job */
  timings: Record<string, number>;
  bottleneck: { stage: string; ms: number; share: number };
  fallbacks: FallbackRecord[];
  economics: UnitEconomics;
}

class StageClock {
  readonly timings: Record<string, number> = {};
  async time<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      this.timings[stage] = (this.timings[stage] ?? 0) + (Date.now() - t);
    }
  }
}

type Chain = <P extends ProviderBase, R>(
  capability: Capability,
  providers: readonly P[],
  estimate: (p: P) => number,
  run: (p: P) => Promise<R>,
) => Promise<ChainOutcome<P, R>>;

/** Everything one A/B arm shares across its locales and platforms. */
interface Arm {
  variantKey: string;
  plan: ReelPlan;
  director: DirectorProvider;
  gv: GenerativeVideoDecision[];
  clips: ShotClip[];
  masterVideo: MasterVideo;
  music: MusicTrack;
  sfx: SfxCueFile[];
}

/** Per-job context handed to the steps. */
interface JobCtx {
  job: ReelJob;
  source: ProductSource;
  brand: BrandProfile;
  tier: TierProfile;
  profile: ProductProfile;
  registry: ProviderRegistry;
  tracker: CostTracker;
  gate: BudgetGate;
  clock: StageClock;
  fallbacks: FallbackRecord[];
  memory: HookMemory;
  jobDir: string;
  workDir: string;
  log: Logger;
  chain: Chain;
  ctxFor: (scope: string) => CallContext;
  signal?: AbortSignal;
}

export class ReelFactory {
  private readonly tools: ReelTools;
  private readonly now: () => Date;

  constructor(private readonly deps: FactoryDeps) {
    this.tools = deps.tools ?? resolveReelTools(deps.env);
    this.now = deps.now ?? (() => new Date());
  }

  async produce(input: ProduceInput, opts: { signal?: AbortSignal } = {}): Promise<ProduceResult> {
    const started = Date.now();
    const job = ReelJob.parse(input.job);
    const { source, brand } = input;
    const tier = TIER_PROFILES[job.tier];
    const budgetUsd = job.maxApiCost ?? tier.defaultMaxApiCostUsd;
    const tracker = new CostTracker();
    const gate = new BudgetGate(Math.round(budgetUsd * 1e6), tracker);
    const clock = new StageClock();
    const fallbacks: FallbackRecord[] = [];
    const log = this.deps.logger.child({ jobId: job.jobId, productId: job.productId });
    const jobDir = path.join(this.tools.outputDir, job.jobId);
    const workDir = path.join(this.tools.workDir, "reel", job.jobId);
    await fsp.mkdir(jobDir, { recursive: true });
    await fsp.mkdir(workDir, { recursive: true });
    const ctxFor = (scope: string): CallContext => ({
      workDir,
      cacheDir: this.tools.cacheDir,
      logger: log,
      scope,
      tracker,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const registry = buildRegistry({
      env: this.deps.env,
      tier,
      googleAI: this.deps.googleAI,
      tools: this.tools,
      job,
      logger: log,
    });
    const chain: Chain = async <P extends ProviderBase, R>(
      capability: Capability,
      providers: readonly P[],
      estimate: (p: P) => number,
      run: (p: P) => Promise<R>,
    ) => {
      const out = await runChain<P, R>({
        capability,
        providers,
        budget: gate,
        estimate,
        run,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (
        out.fallback &&
        !fallbacks.some((f) => f.capability === capability && f.used === out.fallback!.used)
      )
        fallbacks.push(out.fallback);
      return out;
    };

    await this.deps.store.jobStarted(job, budgetUsd);
    log.info(
      { tier: tier.tier, budgetUsd, locales: job.locales.map((l) => l.locale), chains: registry.chains },
      "reel job started",
    );

    try {
      // 1. product profile — analysed once per source version, then cached (DB or file store)
      const profile = await clock.time("analysis", () =>
        this.profileFor(source, registry, ctxFor("master"), chain),
      );
      const memory = new HookMemory(this.tools.cacheDir);
      const jc: JobCtx = {
        job,
        source,
        brand,
        tier,
        profile,
        registry,
        tracker,
        gate,
        clock,
        fallbacks,
        memory,
        jobDir,
        workDir,
        log,
        chain,
        ctxFor,
        ...(opts.signal ? { signal: opts.signal } : {}),
      };

      // 2. existing assets worth reusing (local index; query embeddings only above ECONOMY)
      const index = new AssetIndex(this.tools.cacheDir);
      const retriever = new AssetRetriever(index, registry.embedding[0]);
      const retrieved = await clock.time("retrieval", () =>
        retriever.retrieveFor(
          profile,
          { productModelSha: source.model3d?.sha256 },
          registry.embedding.length ? ctxFor("master") : undefined,
        ),
      );
      const master = job.locales[0]!;
      const history = memory.bestFor(profile.category, job.platform, master.locale);
      const category = profile.category as CategoryKey;
      const hookCtx: HookContext = {
        category,
        profile,
        facts: source.facts,
        concepts: detectConcepts(source.facts, category),
        ...(source.price
          ? {
              price: {
                amount: source.price.amount,
                currency: source.price.currency,
                factId: source.price.factId,
              },
            }
          : {}),
      };
      const arms: (HookStrategy | undefined)[] = job.abHooks.length ? job.abHooks : [undefined];
      const variants: VariantResult[] = [];
      let armA: Arm | null = null;

      for (const [armIndex, hookStrategy] of arms.entries()) {
        const variantKey = String.fromCharCode(65 + armIndex); // A, B, C …
        let arm: Arm;
        if (armA && job.abMode === "copy" && hookStrategy) {
          // cheap A/B: same shots, master video, music and SFX — only the hook copy and the spoken hook change
          const rehooked = rehookPlan(armA.plan, hookStrategy, variantKey, hookCtx);
          if (!rehooked) {
            log.warn({ hookStrategy }, "A/B arm skipped: the product's facts do not support this hook");
            continue;
          }
          arm = { ...armA, variantKey, plan: rehooked };
        } else {
          arm = await this.buildArm(jc, { variantKey, hookStrategy, master, retrieved, history, index });
          armA ??= arm;
        }

        // 7. localizations of the master copy (transcreation + claim validation)
        const copies = await clock.time("transcreation", () => this.localizeCopies(jc, arm.plan));

        for (const [li, { copy, provider: transcreationProvider }] of copies.entries()) {
          const localized: ReelPlan = { ...arm.plan, language: copy.locale, market: copy.market, copy };
          let reuseAudio: { path: string; lufs: number; truePeakDb: number } | undefined;
          let voice: VoiceTrack | undefined;
          const platforms = [job.platform, ...job.extraPlatforms.filter((p) => p !== job.platform)];
          for (const [pi, pid] of platforms.entries()) {
            const platform = PLATFORM_PROFILES[pid];
            const out = await this.deliver(jc, {
              arm,
              plan: { ...localized, platform: pid, cta: { ...localized.cta, style: platform.cta.style } },
              platform,
              primary: pi === 0,
              masterCopy: li === 0,
              transcreationProvider,
              ...(reuseAudio ? { reuseAudio } : {}),
              ...(voice ? { voice } : {}),
              onRerender: (next) => {
                arm = next;
                if (armA?.variantKey === next.variantKey) armA = next;
              },
            });
            variants.push(out.variant);
            // every platform of a locale shares the identical mix (all platform loudness targets are equal)
            if (pi === 0 && out.audio.normalised) {
              reuseAudio = out.audio;
              voice = out.voice;
            }
          }
        }
      }

      const totalApiCostUsd = tracker.spentMicros() / 1e6;
      const timings = { ...clock.timings };
      const total = Object.values(timings).reduce((a, b) => a + b, 0) || 1;
      const [stage, ms] = Object.entries(timings).sort((a, b) => b[1] - a[1])[0] ?? ["none", 0];
      const economics = unitEconomics({
        apiUsd: totalApiCostUsd,
        wallMs: Date.now() - started,
        usdPerHour: this.deps.env.REEL_COMPUTE_USD_PER_HOUR,
        reels: variants.length,
        commission: job.economics,
        ...(source.price ? { price: source.price } : {}),
      });
      await this.deps.store.jobFinished(job.jobId, "DONE", { totalApiCostUsd, timings });
      log.info({ economics, variants: variants.length }, "reel job done");
      return {
        jobId: job.jobId,
        variants,
        totalApiCostUsd,
        timings,
        bottleneck: { stage, ms, share: ms / total },
        fallbacks,
        economics,
      };
    } catch (e) {
      await this.deps.store.jobFinished(job.jobId, "FAILED", {
        totalApiCostUsd: tracker.spentMicros() / 1e6,
        timings: clock.timings,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  /* ---------------------------------------------------------------- arm (visuals + audio bed) ---- */

  private async buildArm(
    jc: JobCtx,
    a: {
      variantKey: string;
      hookStrategy: HookStrategy | undefined;
      master: { locale: string; market: string };
      retrieved: Retrieved;
      history: { hookStrategy: string; score: number }[];
      index: AssetIndex;
    },
  ): Promise<Arm> {
    const { job, source, profile, brand, clock, ctxFor, gate, registry, log } = jc;
    // 3. director → decision → master plan (claims validated; the chain falls back on rejected copy)
    const input = directorInput(
      job,
      source,
      profile,
      brand,
      a.master,
      a.retrieved,
      a.history,
      a.hookStrategy,
    );
    const { plan: basePlan, director } = await clock.time("director", () =>
      this.directPlan(jc, a.variantKey, a.master, input),
    );

    // 4. generative-video ladder (off by default; every decision is recorded in the manifest)
    const gv = decideGenerativeVideo(basePlan, {
      tier: jc.tier,
      enabled: this.deps.env.GENERATIVE_VIDEO_ENABLED,
      envMaxSeconds: this.deps.env.REEL_MAX_GENERATIVE_VIDEO_SECONDS,
      jobAllows: job.allowGenerativeVideo,
      existingAssets: new Set<string>(),
      multiPartModel: false,
      remainingBudgetUsd: gate.remainingMicros() / 1e6,
      usdPerSecond: registry.video[0]
        ? registry.video[0].estimateMicros({ prompt: "", seconds: 1, aspect: "9:16", seed: "" }) / 1e6
        : 0,
      specialShots: new Set<string>(),
    });
    const plan = applyGenerativeVideoDecisions(basePlan, gv);

    // 5. visuals: Blender shots (cached per shot spec) → master video
    const { clips, masterVideo } = await this.visuals(jc, plan, a.variantKey);
    await this.registerRenders(a.index, source, clips).catch((e: unknown) =>
      log.warn({ err: String(e) }, "asset index update failed"),
    );

    // 6. audio bed shared by every locale and platform of the arm: music + SFX
    const music = await clock.time("music", () => this.music(jc, plan));
    const sfx = await clock.time("sfx", () =>
      buildSfxCues(plan, registry.sfx, ctxFor("master"), {
        budget: gate,
        onFallback: (f) => {
          if (!jc.fallbacks.some((x) => x.capability === f.capability && x.used === f.used))
            jc.fallbacks.push(f);
        },
      }),
    );
    return { variantKey: a.variantKey, plan, director, gv, clips, masterVideo, music, sfx };
  }

  private async visuals(
    jc: JobCtx,
    plan: ReelPlan,
    variantKey: string,
  ): Promise<{ clips: ShotClip[]; masterVideo: MasterVideo }> {
    const produced = await jc.clock.time("blender", () =>
      produceShotClips(plan, jc.source, plan.render_profile.blender, jc.ctxFor("master"), {
        emitsLight: jc.profile.traits.emitsLight,
        // one log line per finished shot and every 10th frame (ops can see where a long render is)
        onProgress: (p) => {
          if (p.frame === p.total || p.frame % 10 === 0)
            jc.log.info({ shot: p.shotId, frame: `${p.frame}/${p.total}`, ms: p.ms }, "studio progress");
        },
      }),
    );
    if (produced.skipped.length)
      jc.log.warn({ skipped: produced.skipped }, "shots not rendered by the studio");
    const clips = produced.clips;
    const masterVideo = await jc.clock.time("ffmpeg_master", () =>
      composeMaster({
        plan,
        clips,
        outPath: path.join(jc.jobDir, `${variantKey}.master.mp4`),
        workDir: jc.workDir,
        cacheDir: this.tools.cacheDir,
        tracker: jc.tracker,
        scope: "master",
        ...(jc.signal ? { signal: jc.signal } : {}),
      }),
    );
    return { clips, masterVideo };
  }

  /* ---------------------------------------------------------------- one delivered reel ----------- */

  private async deliver(
    jc: JobCtx,
    a: {
      arm: Arm;
      plan: ReelPlan;
      platform: PlatformProfile;
      primary: boolean;
      masterCopy: boolean;
      transcreationProvider: string;
      reuseAudio?: { path: string; lufs: number; truePeakDb: number };
      /** voice of the primary platform pass (same locale copy) */
      voice?: VoiceTrack;
      onRerender: (arm: Arm) => void;
    },
  ): Promise<{
    variant: VariantResult;
    audio: { path: string; lufs: number; truePeakDb: number; normalised: boolean };
    voice?: VoiceTrack;
  }> {
    const { job, brand, profile, registry, clock, log } = jc;
    let arm = a.arm;
    let localized = a.plan;
    const platform = a.platform;
    const locale = localized.copy.locale;
    const scope = `${arm.variantKey}:${locale}:${platform.id}`;
    const ctx = jc.ctxFor(scope);
    const variantId = `${job.jobId}-${arm.variantKey}-${locale}${a.primary ? "" : `-${platform.id}`}`;
    const outVideo = path.join(jc.jobDir, `${variantId}.mp4`);
    const outPoster = path.join(jc.jobDir, `${variantId}.jpg`);
    const measurer = new FileFontMeasurer({
      [`${brand.fonts.display.family}|${brand.fonts.display.weight}`]: brand.fonts.display.file,
      [`${brand.fonts.body.family}|${brand.fonts.body.weight}`]: brand.fonts.body.file,
      [`${brand.fonts.captions.family}|${brand.fonts.captions.weight}`]: brand.fonts.captions.file,
    });
    let qa: QaReport | null = null;
    let served: ServedProviders | null = null;
    let assPath: string | undefined;
    let audio = { path: "", lufs: 0, truePeakDb: 0, normalised: false };
    let voice: VoiceTrack | undefined = a.voice;
    let reuseAudio = a.reuseAudio;
    const retries: QaReport["retries"] = [];

    for (let attempt = 1; attempt <= 3; attempt++) {
      // the voice depends only on the locale copy and timing — reused by every platform via the audio mix
      if (localized.voiceover.enabled && !voice)
        voice = await clock.time("voice", () =>
          buildVoiceTrack({
            plan: localized,
            copy: localized.copy,
            persona: brand.voicePersona,
            voiceChain: registry.voice,
            transcriptionChain: registry.transcription,
            ctx,
            budget: jc.gate,
          }),
        );
      if (voice && "issues" in voice && Array.isArray(voice.issues) && voice.issues.length)
        log.warn({ variantId, issues: voice.issues }, "voice track issues");
      const layout = buildTextElements({ plan: localized, brand, platform, measurer });
      const rawCaptions =
        localized.captions.enabled && voice
          ? buildCaptionTrack({ voice, plan: localized, platform, brand, measurer })
          : undefined;
      const offset = localized.captions.offsetYPx ?? 0;
      const captions = rawCaptions
        ? {
            ...rawCaptions,
            // the spoken hook is already on screen as the hook headline — don't print it twice
            phrases: withoutHookEcho(rawCaptions.phrases, layout.elements, localized),
            ...(offset ? { box: { ...rawCaptions.box, y: rawCaptions.box.y + offset } } : {}),
          }
        : undefined;
      if (layout.issues.length) log.warn({ variantId, issues: layout.issues }, "text layout issues");
      const composed = await clock.time("ffmpeg_localized", () =>
        composeLocalized({
          plan: localized,
          masterPath: arm.masterVideo.path,
          music: arm.music,
          ...(voice ? { voice } : {}),
          sfx: arm.sfx,
          ...(captions ? { captions } : {}),
          texts: layout.elements,
          platform,
          ...(brand.logo ? { logo: brand.logo } : {}),
          ...(reuseAudio ? { reuseAudio } : {}),
          outPath: outVideo,
          posterPath: outPoster,
          workDir: jc.workDir,
          tracker: jc.tracker,
          scope,
          ...(jc.signal ? { signal: jc.signal } : {}),
        }),
      );
      assPath = composed.assPath;
      audio = { path: composed.audioPath, ...composed.audio };
      qa = await clock.time("qa", () =>
        runReelQa({
          videoPath: outVideo,
          plan: localized,
          platform,
          clips: arm.clips,
          texts: layout.elements,
          ...(captions ? { captions } : {}),
          ...(voice ? { voice } : {}),
          brand,
          logoExpected: Boolean(brand.logo),
          visualQa: registry.visualQa,
          budget: jc.gate,
          ctx,
        }),
      );
      qa = await this.accuracyChecks(qa, outVideo, arm.clips, profile, localized);
      served = {
        director: arm.director.name,
        directorModel: arm.director.model,
        productAnalysis: profile.analyzer.provider,
        transcreation: a.masterCopy ? "master" : a.transcreationProvider,
        image: "none",
        music: arm.music.provider,
        voice: voice?.provider ?? "none",
        sfx: arm.sfx[0]?.provider ?? registry.sfx[0]?.name ?? "none",
        transcription: voice?.timingsSource ?? "none",
        video: arm.gv.some((d) => d.used) ? "veo" : "blender",
        visualQa: qa.visualQa?.provider ?? "deterministic",
      };
      if (!qa.rerenderRequired || attempt === 3) break;
      // deterministic retry: patch the plan from fix codes, re-render only what changed
      const retry = planRetry(qa, localized);
      if (!retry.fixes.length) break;
      const visualChanged =
        stableStringify(visualPart(retry.patched)) !== stableStringify(visualPart(localized));
      if (visualChanged && !a.primary) {
        log.warn(
          { variantId, fixes: retry.fixes },
          "visual fix requested on a secondary platform — kept the shared master",
        );
        break;
      }
      retries.push({ attempt, fixes: retry.fixes });
      log.warn({ variantId, fixes: retry.fixes }, "QA requested a deterministic re-render");
      const audioChanged =
        stableStringify([
          retry.patched.render_profile.audio,
          retry.patched.shots.map((s) => [s.startMs, s.durationMs]),
        ]) !==
        stableStringify([
          localized.render_profile.audio,
          localized.shots.map((s) => [s.startMs, s.durationMs]),
        ]);
      localized = retry.patched;
      if (audioChanged) {
        reuseAudio = undefined;
        voice = undefined;
      }
      if (visualChanged) {
        const plan = {
          ...arm.plan,
          shots: localized.shots,
          cta: localized.cta,
          structure: localized.structure,
        };
        const v = await this.visuals(jc, plan, arm.variantKey);
        arm = { ...arm, plan, ...v };
        a.onRerender(arm);
      }
    }

    const finalQa: QaReport = { ...qa!, retries: [...qa!.retries, ...retries] };
    const planPath = path.join(jc.jobDir, `${variantId}.plan.json`);
    await fsp.writeFile(planPath, JSON.stringify(localized, null, 1));
    const manifest = buildManifest({
      plan: localized,
      variantId,
      brandId: brand.brandId,
      tier: job.tier,
      served: served!,
      clips: arm.clips,
      timings: { ...clock.timings },
      tracker: jc.tracker,
      scope,
      fallbacks: jc.fallbacks,
      generativeVideo: arm.gv,
      master: {
        path: arm.masterVideo.path,
        visualHash: arm.masterVideo.visualHash,
        reused: !a.primary || !a.masterCopy || arm.masterVideo.reused,
      },
      qa: finalQa,
      output: {
        video: outVideo,
        poster: outPoster,
        plan: planPath,
        ...(assPath ? { captions: assPath } : {}),
      },
      attribution: jc.source.source.attribution ?? jc.source.source.license,
      createdAt: this.now().toISOString(),
    });
    const manifestPath = path.join(jc.jobDir, `${variantId}.manifest.json`);
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 1));
    await this.deps.store.variantDelivered(manifest, localized);
    await jc.memory.record({
      at: this.now().toISOString(),
      strategy: localized.metadata.hookStrategy,
      category: profile.category,
      platform: platform.id,
      locale,
      productId: jc.source.id,
      variantId,
    });
    log.info(
      { variantId, qa: finalQa.score, passed: finalQa.passed, costUsd: manifest.totalApiCostUsd },
      "variant delivered",
    );
    return {
      variant: {
        variantId,
        variantKey: arm.variantKey,
        locale,
        platform: platform.id,
        video: outVideo,
        poster: outPoster,
        manifestPath,
        planPath,
        manifest,
      },
      audio,
      ...(voice ? { voice } : {}),
    };
  }

  /* ---------------------------------------------------------------- steps ----------------------- */

  private async profileFor(
    source: ProductSource,
    registry: ProviderRegistry,
    ctx: CallContext,
    chain: Chain,
  ): Promise<ProductProfile> {
    const sourceHash = sha256Hex(stableStringify(source)).slice(0, 24);
    const head = registry.analysis[0]!;
    const version = `${head.name}:${head.model}`;
    const cached = await this.deps.store.getProfile(source.id, sourceHash, version);
    if (cached) {
      ctx.tracker.record({
        capability: "product_analysis",
        provider: "cache",
        model: version,
        costMicros: 0,
        estimated: false,
        cached: true,
        scope: ctx.scope,
      });
      return cached;
    }
    const out = await chain(
      "product_analysis",
      registry.analysis,
      (p) => p.estimateMicros(source),
      (p) => p.analyze(source, ctx),
    );
    // only the chain head's profile is cached under its version (a fallback profile is re-tried next time)
    if (out.provider === head) await this.deps.store.putProfile(source.id, out.result, version);
    return out.result;
  }

  private async directPlan(
    jc: JobCtx,
    variantKey: string,
    master: { locale: string; market: string },
    input: DirectorInput,
  ): Promise<{ plan: ReelPlan; director: DirectorProvider }> {
    const platform = PLATFORM_PROFILES[jc.job.platform];
    const ctx = jc.ctxFor("master");
    const out = await jc.chain(
      "director",
      jc.registry.director,
      (p) => p.estimateMicros(input),
      async (p) => {
        const { decision, promptVersion } = await p.direct(input, ctx);
        const plan = compilePlan({
          decision,
          job: jc.job,
          source: jc.source,
          profile: jc.profile,
          brand: jc.brand,
          platform,
          tier: jc.tier,
          locale: master.locale,
          market: master.market,
          variantKey,
          director: {
            provider: p.name,
            model: p.model,
            promptVersion,
            fallbackUsed: p !== jc.registry.director[0],
          },
          providers: jc.registry.planned,
          fallbacks: jc.registry.chains,
          configVersion: FACTORY_VERSION,
        });
        const blockers = validateCopy(plan.copy, jc.source, jc.brand, jc.profile).filter(
          (i) => i.severity === "blocker",
        );
        if (blockers.length)
          throw new Error(`director copy rejected: ${blockers.map((i) => i.message).join("; ")}`);
        return plan;
      },
    );
    return { plan: out.result, director: out.provider };
  }

  private async music(jc: JobCtx, plan: ReelPlan): Promise<MusicTrack> {
    const ctx = jc.ctxFor("master");
    const out = await jc.chain(
      "music",
      jc.registry.music,
      (p) => p.estimateMicros(plan.music.intent),
      (p) => p.compose(plan.music.intent, ctx),
    );
    const r = out.result;
    const fitted =
      Math.abs(r.durationMs - plan.durationMs) > 40
        ? (
            await fitMusicToTimeline(r.path, plan.music.intent, plan.durationMs, {
              outPath: path.join(
                jc.workDir,
                `music-${sha256Hex(`${r.path}:${plan.durationMs}`).slice(0, 12)}.wav`,
              ),
              sourceBpm: r.bpm,
              ...(jc.signal ? { signal: jc.signal } : {}),
            })
          ).path
        : r.path;
    return {
      path: fitted,
      durationMs: plan.durationMs,
      bpm: r.bpm,
      provider: out.provider.name,
      model: out.provider.model,
      license: r.license,
      cached: r.cached,
    };
  }

  private async localizeCopies(
    jc: JobCtx,
    plan: ReelPlan,
  ): Promise<{ copy: LocaleCopy; provider: string }[]> {
    const targets = jc.job.locales.slice(1);
    const masterOut = { copy: plan.copy, provider: "master" };
    if (!targets.length) return [masterOut];
    const req = {
      master: plan.copy,
      targets,
      product: jc.profile,
      productNames: jc.source.names,
      facts: jc.source.facts.map((f) => ({ id: f.id, kind: f.kind, text: f.text })),
      sourceFacts: jc.source.facts,
      brand: jc.brand,
      limits: slotLimits(plan.copy),
      hookStrategy: plan.metadata.hookStrategy,
    };
    const ctx = jc.ctxFor("master");
    const out = await jc.chain(
      "transcreation",
      jc.registry.transcreation,
      (p: TranscreationProvider) => p.estimateMicros(req),
      async (p: TranscreationProvider) => {
        const copies = await p.transcreate(req, ctx);
        for (const c of copies) {
          const blockers = validateCopy(c, jc.source, jc.brand, jc.profile).filter(
            (i) => i.severity === "blocker",
          );
          if (blockers.length)
            throw new Error(`${c.locale} copy rejected: ${blockers.map((i) => i.message).join("; ")}`);
        }
        return copies;
      },
    );
    return [masterOut, ...out.result.map((copy) => ({ copy, provider: out.provider.name }))];
  }

  /** product accuracy on the delivered frames: the rendered product keeps the catalog colours */
  private async accuracyChecks(
    qa: QaReport,
    videoPath: string,
    clips: ShotClip[],
    profile: ProductProfile,
    plan: ReelPlan,
  ): Promise<QaReport> {
    const hero = plan.shots.find((s) => s.role === "CTA") ?? plan.shots[0];
    const clip = clips.find((c) => c.shotId === hero?.id);
    const sample = clip?.productTrack[Math.floor(clip.productTrack.length / 2)];
    if (!hero || !sample || !profile.palette.length) return qa;
    const W = plan.resolution.width;
    const H = plan.resolution.height;
    const r = sample.rect;
    const rect =
      Math.max(Math.abs(r.x), Math.abs(r.y), r.w, r.h) <= 1.5
        ? { x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H }
        : r;
    const res = await checkRenderedColors({
      videoPath,
      atMs: hero.startMs + Math.round(hero.durationMs / 2),
      rect,
      expectedPalette: profile.palette,
      frame: { width: W, height: H },
    });
    const check = { id: "product_colors", passed: res.passed, value: res, note: res.note };
    return {
      ...qa,
      checks: [...qa.checks, check],
      issues: res.passed
        ? qa.issues
        : [...qa.issues, { code: "product_color_mismatch", severity: "major", message: res.note }],
    };
  }

  /** studio renders of this exact 3D model become reusable assets for later jobs */
  private async registerRenders(index: AssetIndex, source: ProductSource, clips: ShotClip[]): Promise<void> {
    const sha = source.model3d?.sha256;
    if (!sha) return;
    await index.upsert(
      clips.map((c) => ({
        id: `render:${source.id}:${path.basename(c.path, path.extname(c.path))}`,
        kind: "render" as const,
        tags: [source.id, "render", c.shotId],
        text: `${source.id} studio clip ${c.shotId} (${c.durationMs} ms)`,
        path: c.path,
        meta: { productModelSha: sha, shotId: c.shotId, durationMs: c.durationMs },
      })),
    );
  }
}

/* ---------------------------------------------------------------- helpers ----------------------- */

/** Job cost (API + host time) per delivered reel and the sales needed to pay it back. */
export function unitEconomics(a: {
  apiUsd: number;
  wallMs: number;
  usdPerHour: number;
  reels: number;
  commission: { commissionRate?: number; commissionUsd?: number };
  price?: { amount: number; currency: string };
}): UnitEconomics {
  const computeHours = a.wallMs / 3_600_000;
  const computeUsd = computeHours * a.usdPerHour;
  const totalUsd = a.apiUsd + computeUsd;
  const commissionPerSaleUsd =
    a.commission.commissionUsd ??
    (a.commission.commissionRate !== undefined && a.price && a.price.currency === "USD"
      ? a.price.amount * a.commission.commissionRate
      : undefined);
  const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
  return {
    reels: a.reels,
    apiUsd: r4(a.apiUsd),
    computeHours: r4(computeHours),
    computeUsd: r4(computeUsd),
    totalUsd: r4(totalUsd),
    perReelUsd: r4(a.reels ? totalUsd / a.reels : totalUsd),
    ...(commissionPerSaleUsd !== undefined && commissionPerSaleUsd > 0
      ? {
          commissionPerSaleUsd: r4(commissionPerSaleUsd),
          breakEvenSales: Math.max(1, Math.ceil(totalUsd / commissionPerSaleUsd)),
        }
      : {}),
  };
}

/** Caption phrases spoken while the on-screen hook shows the same line are dropped (no double text). */
export function withoutHookEcho<P extends { startMs: number; endMs: number }>(
  phrases: readonly P[],
  texts: readonly { kind: string; startMs: number; endMs: number }[],
  plan: Pick<ReelPlan, "copy">,
): P[] {
  const hook = texts.find((t) => t.kind === "hook");
  const spoken = Object.entries(plan.copy.slots).find(([id]) => /^voice\.\d+\.hook$/.test(id))?.[1]?.text;
  const shown = plan.copy.slots.hook?.text;
  const norm = (x: string) =>
    x
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]/gu, "")
      .trim();
  if (!hook || !spoken || !shown || norm(spoken) !== norm(shown)) return [...phrases];
  return phrases.filter(
    (p) =>
      !(p.startMs < hook.endMs && (Math.min(p.endMs, hook.endMs) - p.startMs) / (p.endMs - p.startMs) > 0.5),
  );
}

function visualPart(plan: ReelPlan): unknown {
  return {
    shots: plan.shots.map(({ overlaySlot: _o, ...s }) => s),
    visual_style: plan.visual_style,
    camera: plan.camera,
    render: plan.render_profile.blender,
  };
}

function slotLimits(copy: LocaleCopy): Record<string, number> {
  const kindMax: Record<string, number> = {
    hook: 70,
    overlay: 60,
    voice: 140,
    cta: 48,
    button: 24,
    disclosure: 80,
    caption: 200,
  };
  const out: Record<string, number> = {};
  for (const [slot, s] of Object.entries(copy.slots))
    out[slot] = Math.min(kindMax[s.kind] ?? 120, Math.max(24, Math.round(s.text.length * 1.3)));
  return out;
}

function directorInput(
  job: ReelJob,
  source: ProductSource,
  profile: ProductProfile,
  brand: BrandProfile,
  master: { locale: string; market: string },
  retrieved: Retrieved,
  history: { hookStrategy: string; score: number }[],
  hookStrategy: HookStrategy | undefined,
): DirectorInput {
  const platform = PLATFORM_PROFILES[job.platform];
  return {
    product: profile,
    facts: source.facts.map((f) => ({ id: f.id, kind: f.kind, text: f.text.slice(0, 220) })),
    ...(source.price
      ? {
          price: {
            amount: source.price.amount,
            currency: source.price.currency,
            factId: source.price.factId,
          },
        }
      : {}),
    brand: {
      brandName: brand.brandName,
      visualStyle: brand.visualStyle,
      musicStyle: brand.musicStyle,
      forbiddenPhrases: brand.forbiddenPhrases,
      preferredCTA: brand.preferredCTA,
      voicePersona: { id: brand.voicePersona.id, description: brand.voicePersona.description },
    },
    platform: {
      id: platform.id,
      durationMs: platform.durationMs,
      avgShotMs: platform.avgShotMs,
      maxOverlayWords: platform.maxOverlayWords,
    },
    locale: master.locale,
    market: master.market,
    targetDurationS: job.targetDurationS,
    objective: job.objective,
    options: {
      shotPresets: SHOT_PRESETS,
      hookStrategies: HOOK_STRATEGIES,
      environments: STUDIO_ENVIRONMENTS,
      sfxKinds: SFX_KINDS,
      musicGenres: MUSIC_GENRES,
      musicMoods: MUSIC_MOODS,
    },
    assets: retrieved.assets.map((x) => ({ id: x.id, kind: x.kind, description: x.description })),
    history,
    ...(hookStrategy ? { hookStrategy } : {}),
  };
}
