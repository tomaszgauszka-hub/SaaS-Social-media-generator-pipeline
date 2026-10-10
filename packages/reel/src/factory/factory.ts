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
import {
  buildCaptionTrack,
  buildSfxCues,
  buildVoiceTrack,
  fitMusicToTimeline,
  type VoiceTrackResult,
} from "../audio/index.ts";
import { runChain, type ChainOutcome } from "../capabilities/chain.ts";
import type {
  CallContext,
  DirectorInput,
  DirectorProvider,
  ProviderBase,
  TranscreationProvider,
} from "../capabilities/types.ts";
import { DETERMINISTIC_ANALYZER_VERSION } from "../analysis/index.ts";
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
import type { MusicTrack, SfxCueFile, ShotClip } from "../contracts/media.ts";
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
import { planRetry, runReelQa, scoreReport } from "../qa/index.ts";
import { AssetIndex, AssetRetriever, type Retrieved } from "../retrieval/index.ts";
import { produceShotClips, sequenceRenderFps } from "../studio/index.ts";
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

/** a capability chain through the job's BudgetGate; a fallback is recorded under the cost scope it served */
type Chain = <P extends ProviderBase, R>(
  capability: Capability,
  providers: readonly P[],
  estimate: (p: P) => number,
  run: (p: P) => Promise<R>,
  scope: string,
) => Promise<ChainOutcome<P, R>>;

/** job-level work every variant shares (product analysis, retrieval) */
const JOB_SCOPE = "master";
const armScope = (variantKey: string) => `${variantKey}:master`;

/** Everything one A/B arm shares across its locales and platforms. */
interface Arm {
  variantKey: string;
  /** cost / fallback scopes of the shared work this arm's reels use (its own + the arm it re-hooks) */
  scopes: string[];
  /** set for a copy-mode arm: the arm whose master, music and SFX it reuses */
  copyOf?: string;
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
  /** fallbacks per cost scope (job, arm, variant) — a manifest lists only those of the work it uses */
  fallbacks: Map<string, FallbackRecord[]>;
  addFallback: (scope: string, f: FallbackRecord) => void;
  memory: HookMemory;
  jobDir: string;
  workDir: string;
  log: Logger;
  chain: Chain;
  ctxFor: (scope: string) => CallContext;
  studioBudgetMs?: number;
  signal?: AbortSignal;
}

export class ReelFactory {
  private readonly tools: ReelTools;
  private readonly now: () => Date;

  constructor(private readonly deps: FactoryDeps) {
    this.tools = deps.tools ?? resolveReelTools(deps.env);
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * `studioBudgetMs` — Blender time one job may spend (the worker passes a share of its job timeout; the CLI
   * none): a QUALITY plan whose estimated studio time exceeds it is rendered with FAST, recorded as a fallback.
   */
  async produce(
    input: ProduceInput,
    opts: { signal?: AbortSignal; studioBudgetMs?: number } = {},
  ): Promise<ProduceResult> {
    const started = Date.now();
    const job = ReelJob.parse(input.job);
    const { source, brand } = input;
    const tier = TIER_PROFILES[job.tier];
    const budgetUsd = job.maxApiCost ?? tier.defaultMaxApiCostUsd;
    // a worker retry of an unfinished job continues on the budget its earlier attempts left
    const priorUsd = (await this.deps.store.jobStarted(job, budgetUsd))?.priorApiCostUsd ?? 0;
    const tracker = new CostTracker();
    const gate = new BudgetGate(Math.max(0, Math.round((budgetUsd - priorUsd) * 1e6)), tracker);
    const clock = new StageClock();
    const fallbacks = new Map<string, FallbackRecord[]>();
    const addFallback = (scope: string, f: FallbackRecord) => {
      const list = fallbacks.get(scope) ?? [];
      if (!list.some((x) => x.capability === f.capability && x.used === f.used)) list.push(f);
      fallbacks.set(scope, list);
    };
    const log = this.deps.logger.child({ jobId: job.jobId, productId: job.productId });
    const jobDir = inside(this.tools.outputDir, job.jobId);
    const workDir = inside(path.join(this.tools.workDir, "reel"), job.jobId);
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
      scope: string,
    ) => {
      const out = await runChain<P, R>({
        capability,
        providers,
        budget: gate,
        estimate,
        run,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (out.fallback) addFallback(scope, out.fallback);
      return out;
    };

    log.info(
      {
        tier: tier.tier,
        budgetUsd,
        ...(priorUsd ? { priorUsd } : {}),
        locales: job.locales.map((l) => l.locale),
        chains: registry.chains,
      },
      "reel job started",
    );

    try {
      // 1. product profile — analysed once per source version, then cached (DB or file store)
      const profile = await clock.time("analysis", () =>
        this.profileFor(source, registry, ctxFor(JOB_SCOPE), chain),
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
        addFallback,
        memory,
        jobDir,
        workDir,
        log,
        chain,
        ctxFor,
        ...(opts.studioBudgetMs ? { studioBudgetMs: opts.studioBudgetMs } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      };

      // 2. existing assets worth reusing (local index; a query embedding only above ECONOMY, through the
      //    BudgetGate — it only refines the ranking, so any failure falls back to lexical / tag search)
      const index = new AssetIndex(this.tools.cacheDir);
      const retriever = new AssetRetriever(index);
      const retrieved = await clock.time("retrieval", () =>
        retriever.retrieveFor(profile, { productModelSha: source.model3d?.sha256 }, (text) =>
          this.queryEmbedding(jc, text),
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
      let copiesA: { copy: LocaleCopy; provider: string }[] = [];

      for (const [armIndex, hookStrategy] of arms.entries()) {
        const variantKey = String.fromCharCode(65 + armIndex); // A, B, C …
        let arm: Arm;
        let copies: { copy: LocaleCopy; provider: string }[];
        if (armA && job.abMode === "copy" && hookStrategy) {
          // cheap A/B: same shots, master video, music and SFX — only the hook copy and the spoken hook change
          const rehooked = rehookPlan(armA.plan, hookStrategy, variantKey, hookCtx);
          if (!rehooked) {
            log.warn({ hookStrategy }, "A/B arm skipped: the product's facts do not support this hook");
            continue;
          }
          // the re-hooked master copy is new copy: it passes the same claim gate as a directed plan
          const blockers = validateCopy(rehooked.copy, source, brand, profile, {
            modelWritten: !armA.director.local,
          }).filter((i) => i.severity === "blocker");
          if (blockers.length) {
            log.warn(
              { hookStrategy, blockers: blockers.map((b) => b.message) },
              "A/B arm skipped: its hook copy fails claim validation",
            );
            continue;
          }
          arm = {
            ...armA,
            variantKey,
            scopes: [...armA.scopes, armScope(variantKey)],
            copyOf: armA.variantKey,
            plan: rehooked,
          };
          // 7a. localizations: arm A's copies with only the re-hooked slots transcreated (the arms differ in
          //     the hook alone — a clean test, and the transcreation cost of a few lines)
          copies = await clock.time("transcreation", () =>
            this.localizeCopies(jc, arm.plan, armScope(variantKey), { base: copiesA, from: armA!.plan }),
          );
        } else {
          arm = await this.buildArm(jc, { variantKey, hookStrategy, master, retrieved, history, index });
          // 7. localizations of the master copy (transcreation + claim validation)
          copies = await clock.time("transcreation", () =>
            this.localizeCopies(jc, arm.plan, armScope(variantKey)),
          );
          if (!armA) {
            armA = arm;
            copiesA = copies;
          }
        }

        for (const [li, { copy, provider: transcreationProvider }] of copies.entries()) {
          let reuseAudio: { path: string; lufs: number; truePeakDb: number } | undefined;
          let voice: VoiceTrackResult | undefined;
          // the primary platform's final render profile (a renormalize fix) travels with its reused mix
          let carried: Pick<ReelPlan, "render_profile"> | undefined;
          const platforms = [job.platform, ...job.extraPlatforms.filter((p) => p !== job.platform)];
          for (const [pi, pid] of platforms.entries()) {
            const platform = PLATFORM_PROFILES[pid];
            // built from the CURRENT arm: a QA retry of the primary may have re-rendered the master
            const base: ReelPlan = {
              ...arm.plan,
              language: copy.locale,
              market: copy.market,
              copy,
              ...carried,
            };
            const out = await this.deliver(jc, {
              arm,
              plan: { ...base, platform: pid, cta: { ...base.cta, style: platform.cta.style } },
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
              carried = { render_profile: out.plan.render_profile };
            }
          }
        }
      }

      const spentUsd = tracker.spentMicros() / 1e6;
      const totalApiCostUsd = priorUsd + spentUsd;
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
        fallbacks: dedupeFallbacks([...fallbacks.values()].flat()),
        economics,
      };
    } catch (e) {
      await this.deps.store.jobFinished(job.jobId, "FAILED", {
        totalApiCostUsd: priorUsd + tracker.spentMicros() / 1e6,
        timings: clock.timings,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  /** one query vector for asset ranking; null (lexical search) when unavailable, over budget or failing */
  private async queryEmbedding(
    jc: JobCtx,
    text: string,
  ): Promise<{ key: string; values: number[] } | undefined> {
    const items = [{ id: "query", text }];
    const ctx = jc.ctxFor(JOB_SCOPE);
    try {
      const out = await jc.chain(
        "embedding",
        jc.registry.embedding,
        (p) => p.estimateMicros(items),
        async (p) => {
          if (!(await p.available()).ok) throw new Error(`${p.name} unavailable`);
          const [v] = await p.embed(items, ctx);
          if (!v) throw new Error(`${p.name} returned no vector`);
          return { key: `${p.model}@${p.dimensions}`, values: v.vector };
        },
        JOB_SCOPE,
      );
      return out.result;
    } catch (e) {
      if (jc.registry.embedding.length)
        jc.log.info({ err: e instanceof Error ? e.message : String(e) }, "query embedding skipped");
      return undefined;
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
    const scope = armScope(a.variantKey);
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
    const plan = this.fitStudioBudget(jc, applyGenerativeVideoDecisions(basePlan, gv), scope);

    // 5. visuals: Blender shots (cached per shot spec) → master video
    const { clips, masterVideo } = await this.visuals(jc, plan, a.variantKey);
    await this.registerRenders(a.index, source, clips).catch((e: unknown) =>
      log.warn({ err: String(e) }, "asset index update failed"),
    );

    // 6. audio bed shared by every locale and platform of the arm: music + SFX
    const music = await clock.time("music", () => this.music(jc, plan, scope));
    const sfx = await clock.time("sfx", () =>
      buildSfxCues(plan, registry.sfx, ctxFor(scope), {
        budget: gate,
        onFallback: (f) => jc.addFallback(scope, f),
      }),
    );
    return { variantKey: a.variantKey, scopes: [scope], plan, director, gv, clips, masterVideo, music, sfx };
  }

  /** A QUALITY plan the job's Blender budget cannot render is rendered with FAST (and says so). */
  private fitStudioBudget(jc: JobCtx, plan: ReelPlan, scope: string): ReelPlan {
    const profile = plan.render_profile.blender;
    if (!jc.studioBudgetMs || profile !== "QUALITY") return plan;
    const estimate = estimateStudioMs(plan, profile);
    if (estimate <= jc.studioBudgetMs) return plan;
    const reason = `estimated QUALITY studio time ${Math.round(estimate / 60_000)} min exceeds the job's Blender budget of ${Math.round(jc.studioBudgetMs / 60_000)} min`;
    jc.log.warn({ estimateMs: estimate, budgetMs: jc.studioBudgetMs }, reason);
    jc.addFallback(scope, { capability: "render_3d", wanted: "QUALITY", used: "FAST", reason });
    return { ...plan, render_profile: { ...plan.render_profile, blender: "FAST" } };
  }

  private async visuals(
    jc: JobCtx,
    plan: ReelPlan,
    variantKey: string,
  ): Promise<{ clips: ShotClip[]; masterVideo: MasterVideo }> {
    const produced = await jc.clock.time("blender", () =>
      produceShotClips(plan, jc.source, plan.render_profile.blender, jc.ctxFor(armScope(variantKey)), {
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
    for (const sh of produced.shots.filter((x) => x.fallbackTechnique))
      jc.addFallback(armScope(variantKey), {
        capability: "render_3d",
        wanted: sh.technique,
        used: sh.fallbackTechnique!,
        reason: `${sh.shotId}: the product has no light of its own — rendered as one plate`,
      });
    const clips = produced.clips;
    const masterVideo = await jc.clock.time("ffmpeg_master", () =>
      composeMaster({
        plan,
        clips,
        outPath: path.join(jc.jobDir, `${variantKey}.master.mp4`),
        workDir: jc.workDir,
        cacheDir: this.tools.cacheDir,
        tracker: jc.tracker,
        scope: armScope(variantKey),
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
      voice?: VoiceTrackResult;
      onRerender: (arm: Arm) => void;
    },
  ): Promise<{
    variant: VariantResult;
    /** the plan this variant was finally rendered from (after any QA fix) */
    plan: ReelPlan;
    audio: { path: string; lufs: number; truePeakDb: number; normalised: boolean };
    voice?: VoiceTrackResult;
  }> {
    const { job, brand, profile, registry, clock, log } = jc;
    const clockAtStart = { ...clock.timings };
    let arm = a.arm;
    let localized = a.plan;
    const platform = a.platform;
    const locale = localized.copy.locale;
    const scope = `${arm.variantKey}:${locale}:${platform.id}`;
    // the voice is synthesised once per locale (by the primary platform) and reused by the others
    const voiceScope = `${arm.variantKey}:${locale}:voice`;
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
    let voice: VoiceTrackResult | undefined = a.voice;
    let voiceBuiltHere = false;
    let renderedHere = false;
    let reuseAudio = a.reuseAudio;
    const retries: QaReport["retries"] = [];

    for (let attempt = 1; attempt <= 3; attempt++) {
      // the voice depends only on the locale copy and timing — reused by every platform via the audio mix
      if (localized.voiceover.enabled && !voice) {
        voice = await clock.time("voice", () =>
          buildVoiceTrack({
            plan: localized,
            copy: localized.copy,
            persona: brand.voicePersona,
            voiceChain: registry.voice,
            transcriptionChain: registry.transcription,
            ctx: jc.ctxFor(voiceScope),
            budget: jc.gate,
          }),
        );
        voiceBuiltHere = true;
        for (const f of voice.fallbacks) jc.addFallback(voiceScope, f);
        if (voice.issues.length) log.warn({ variantId, issues: voice.issues }, "voice track issues");
      }
      // text panels avoid the product where a readable fit exists (product track of the shared master)
      const layout = buildTextElements({ plan: localized, brand, platform, measurer, clips: arm.clips });
      const rawCaptions =
        localized.captions.enabled && voice
          ? buildCaptionTrack({ voice, plan: localized, platform, brand, measurer })
          : undefined;
      const offset = localized.captions.offsetYPx ?? 0;
      const captions = rawCaptions
        ? {
            ...rawCaptions,
            // the spoken hook / CTA are already on screen as panels — don't print them twice
            phrases: withoutTextEcho(rawCaptions.phrases, layout.elements, localized, voice?.segments),
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
          ...(composed.logoBox ? { logoBox: composed.logoBox } : {}),
          visualQa: registry.visualQa,
          budget: jc.gate,
          ctx,
        }),
      );
      qa = await this.accuracyChecks(qa, outVideo, arm.clips, profile, localized);
      const visualHead = registry.visualQa[0];
      if (visualHead && qa.visualQa && qa.visualQa.provider !== visualHead.name)
        jc.addFallback(scope, {
          capability: "visual_qa",
          wanted: visualHead.name,
          used: qa.visualQa.provider,
          reason: "visual QA chain head unavailable, over budget or failed (see the job log)",
        });
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
        renderedHere = true;
        a.onRerender(arm);
      }
    }

    const finalQa: QaReport = { ...qa!, retries: [...qa!.retries, ...retries] };
    const planPath = path.join(jc.jobDir, `${variantId}.plan.json`);
    await fsp.writeFile(planPath, JSON.stringify(localized, null, 1));
    // marginal wall time of this variant (shared work — studio, music — is in the job's timings)
    const timings = Object.fromEntries(
      Object.entries(clock.timings)
        .map(([k, v]) => [k, v - (clockAtStart[k] ?? 0)] as const)
        .filter(([, v]) => v > 0),
    );
    const own = [scope, ...(voiceBuiltHere ? [voiceScope] : [])];
    const shared = [JOB_SCOPE, ...arm.scopes, ...(voiceBuiltHere ? [] : [voiceScope])];
    // the master was made for this variant only by its own QA re-render or as the first reel of a full arm
    const firstUse = a.primary && a.masterCopy && !arm.copyOf;
    const manifest = buildManifest({
      plan: localized,
      variantId,
      brandId: brand.brandId,
      tier: job.tier,
      served: served!,
      clips: arm.clips,
      timings,
      tracker: jc.tracker,
      scopes: own,
      sharedScopes: shared,
      fallbacks: dedupeFallbacks([...shared, ...own].flatMap((sc) => jc.fallbacks.get(sc) ?? [])),
      generativeVideo: arm.gv,
      master: {
        path: arm.masterVideo.path,
        visualHash: arm.masterVideo.visualHash,
        reused: renderedHere || firstUse ? arm.masterVideo.reused : true,
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
      plan: localized,
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
    // category / light-source rules are shared code (deterministic.ts): their version is part of every key
    const version = `${head.name}:${head.model}:${DETERMINISTIC_ANALYZER_VERSION}`;
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
      ctx.scope,
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
    // the shared master must satisfy every platform it is delivered to: the CTA gets the longest minimum
    const delivered = [jc.job.platform, ...jc.job.extraPlatforms].map((id) => PLATFORM_PROFILES[id]);
    const head = PLATFORM_PROFILES[jc.job.platform];
    const platform: PlatformProfile = {
      ...head,
      cta: { ...head.cta, minMs: Math.max(...delivered.map((p) => p.cta.minMs)) },
    };
    const scope = armScope(variantKey);
    const ctx = jc.ctxFor(scope);
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
        // copy a model wrote gets no benefit of the doubt (an invented number or colour is a blocker)
        const blockers = validateCopy(plan.copy, jc.source, jc.brand, jc.profile, {
          modelWritten: !p.local,
        }).filter((i) => i.severity === "blocker");
        if (blockers.length)
          throw new Error(`director copy rejected: ${blockers.map((i) => i.message).join("; ")}`);
        return plan;
      },
      scope,
    );
    return { plan: out.result, director: out.provider };
  }

  private async music(jc: JobCtx, plan: ReelPlan, scope: string): Promise<MusicTrack> {
    const ctx = jc.ctxFor(scope);
    const out = await jc.chain(
      "music",
      jc.registry.music,
      (p) => p.estimateMicros(plan.music.intent),
      (p) => p.compose(plan.music.intent, ctx),
      scope,
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

  /**
   * Localized copies of a plan's master copy. With `reuse` (a copy-mode A/B arm) the copies of the arm it
   * re-hooks are kept and only the slots whose master text changed are transcreated and merged in, so the
   * arms differ in the hook alone; every merged copy is claim-validated as a whole.
   */
  private async localizeCopies(
    jc: JobCtx,
    plan: ReelPlan,
    scope: string,
    reuse?: { base: { copy: LocaleCopy; provider: string }[]; from: ReelPlan },
  ): Promise<{ copy: LocaleCopy; provider: string }[]> {
    const targets = jc.job.locales.slice(1);
    const masterOut = { copy: plan.copy, provider: "master" };
    const masterBlockers = validateCopy(plan.copy, jc.source, jc.brand, jc.profile, {
      modelWritten: plan.metadata.director.provider !== "template",
    }).filter((i) => i.severity === "blocker");
    if (masterBlockers.length)
      throw new Error(`master copy rejected: ${masterBlockers.map((i) => i.message).join("; ")}`);
    if (!targets.length) return [masterOut];
    const baseFor = (locale: string) => reuse?.base.find((b) => b.copy.locale === locale);
    const partial = Boolean(reuse) && targets.every((t) => baseFor(t.locale));
    const changed = partial
      ? Object.entries(plan.copy.slots).filter(
          ([id, slot]) => stableStringify(reuse!.from.copy.slots[id]) !== stableStringify(slot),
        )
      : Object.entries(plan.copy.slots);
    if (partial && !changed.length) return [masterOut, ...targets.map((t) => baseFor(t.locale)!)];
    const master: LocaleCopy = { ...plan.copy, slots: Object.fromEntries(changed) };
    const req = {
      master,
      targets,
      product: jc.profile,
      productNames: jc.source.names,
      facts: jc.source.facts.map((f) => ({ id: f.id, kind: f.kind, text: f.text })),
      sourceFacts: jc.source.facts,
      brand: jc.brand,
      limits: slotLimits(master),
      hookStrategy: plan.metadata.hookStrategy,
    };
    const ctx = jc.ctxFor(scope);
    const out = await jc.chain(
      "transcreation",
      jc.registry.transcreation,
      (p: TranscreationProvider) => p.estimateMicros(req),
      async (p: TranscreationProvider) => {
        const copies = (await p.transcreate(req, ctx)).map((c): LocaleCopy => {
          const base = partial ? baseFor(c.locale)?.copy : undefined;
          if (!base) return c;
          // a changed slot the transcreator dropped must not fall back to the other arm's line
          const slots = Object.fromEntries(
            Object.entries(base.slots).filter(([id]) => !changed.some(([cid]) => cid === id)),
          );
          return { ...base, slots: { ...slots, ...c.slots } };
        });
        for (const c of copies) {
          const blockers = validateCopy(c, jc.source, jc.brand, jc.profile, {
            modelWritten: !p.local,
          }).filter((i) => i.severity === "blocker");
          if (blockers.length)
            throw new Error(`${c.locale} copy rejected: ${blockers.map((i) => i.message).join("; ")}`);
        }
        return copies;
      },
      scope,
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
    if (res.passed) return { ...qa, checks: [...qa.checks, check] };
    const issues: QaReport["issues"] = [
      ...qa.issues,
      { code: "product_color_mismatch", severity: "major", message: res.note },
    ];
    // a reel that misrepresents the product's colours must not keep the score it had without the check
    return { ...qa, ...scoreReport(issues, qa.visualQa), checks: [...qa.checks, check], issues };
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

const echoTokens = (x: string) =>
  x
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** the spoken line says what the panel shows (≥ 75 % of the panel's words, at most 3 words more) */
export function echoes(spoken: string, shown: string): boolean {
  const said = new Set(echoTokens(spoken));
  const panel = echoTokens(shown);
  if (!panel.length || said.size > panel.length + 3) return false;
  return panel.filter((w) => said.has(w)).length / panel.length >= 0.75;
}

/**
 * Caption phrases that only repeat an on-screen panel are dropped (no double text): the spoken hook while the
 * hook headline shows, the spoken CTA while the CTA panel shows ("Link znajdziesz w bio" under "Link w bio").
 * A phrase goes only when most of it lies inside both the panel's window and its own voice segment.
 */
export function withoutTextEcho<P extends { startMs: number; endMs: number }>(
  phrases: readonly P[],
  texts: readonly { kind: string; startMs: number; endMs: number }[],
  plan: Pick<ReelPlan, "copy">,
  segments: readonly { slot: string; startMs: number; endMs: number }[] = [],
): P[] {
  const inside = (p: P, w: { startMs: number; endMs: number }) =>
    (Math.min(p.endMs, w.endMs) - Math.max(p.startMs, w.startMs)) / Math.max(1, p.endMs - p.startMs) > 0.5;
  const windows: {
    panel: { startMs: number; endMs: number };
    segment?: { startMs: number; endMs: number };
  }[] = [];
  for (const kind of ["hook", "cta"] as const) {
    const panel = texts.find((t) => t.kind === kind);
    const spoken = Object.entries(plan.copy.slots).find(([id]) =>
      new RegExp(`^voice\\.\\d+\\.${kind}$`).test(id),
    );
    const shown = plan.copy.slots[kind]?.text;
    if (!panel || !spoken || !shown || !echoes(spoken[1].text, shown)) continue;
    const segment = segments.find((s) => s.slot === spoken[0]);
    windows.push({ panel, ...(segment ? { segment } : {}) });
  }
  return phrases.filter(
    (p) => !windows.some((w) => inside(p, w.panel) && (!w.segment || inside(p, w.segment))),
  );
}

/** `root/<id>` — refuses an id that would leave the root (ids are validated upstream; this is the backstop) */
function inside(root: string, id: string): string {
  const base = path.resolve(root);
  const dir = path.resolve(base, id);
  if (!dir.startsWith(`${base}${path.sep}`)) throw new Error(`job id leaves ${root}: ${id}`);
  return dir;
}

/** Worst-case Blender wall time of a plan without cache hits (4 vCPU measurements; QUALITY extrapolated). */
const STUDIO_MS: Record<ReelPlan["render_profile"]["blender"], { plate: number; frame: number }> = {
  FAST: { plate: 25_000, frame: 12_000 },
  QUALITY: { plate: 300_000, frame: 200_000 },
};

export function estimateStudioMs(
  plan: Pick<ReelPlan, "shots">,
  profile: ReelPlan["render_profile"]["blender"],
): number {
  const ms = STUDIO_MS[profile];
  return plan.shots.reduce((sum, sh) => {
    if (sh.source !== "blender") return sum;
    if (sh.technique === "sequence")
      return sum + Math.ceil((sh.durationMs / 1000) * sequenceRenderFps(sh.preset, profile)) * ms.frame;
    return sum + (sh.technique === "relight" ? 2 : 1) * ms.plate;
  }, 0);
}

function dedupeFallbacks(list: readonly FallbackRecord[]): FallbackRecord[] {
  const out: FallbackRecord[] = [];
  for (const f of list)
    if (!out.some((x) => x.capability === f.capability && x.wanted === f.wanted && x.used === f.used))
      out.push(f);
  return out;
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
