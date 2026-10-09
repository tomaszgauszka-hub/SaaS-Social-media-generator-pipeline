import type { Logger } from "@cre/shared";
import type { CostEntryInput, ComputeEntryInput } from "../contracts/cost.ts";
import type { Capability, LocaleTag, SfxKind } from "../contracts/ids.ts";
import type { DirectorDecision, LocaleCopy, MusicIntent } from "../contracts/plan.ts";
import type { ProductProfile, ProductSource } from "../contracts/product.ts";
import type { BrandProfile, PlatformProfile, VoicePersona } from "../contracts/profiles.ts";
import type { WordTime } from "../contracts/media.ts";

/*
 * Capability contracts of the reel factory. Each capability has an ordered chain of providers
 * (cache → local deterministic → cheap API → LLM → generation → generative video). A provider reports whether
 * it can run at all (`available` — e.g. an API key is configured, a binary exists) and what a call would cost
 * BEFORE it runs, so the CostEngine can refuse it when the reel budget would be exceeded.
 */

export interface CallContext {
  workDir: string;
  cacheDir: string;
  logger?: Logger;
  signal?: AbortSignal;
  /** which variant the call serves ("master", "pl-PL", "B" …) — cost scope */
  scope: string;
  /** every API call and every local compute step is recorded here */
  tracker: CostRecorder;
}

export interface CostRecorder {
  record(entry: CostEntryInput): void;
  compute(entry: ComputeEntryInput): void;
}

export interface ProviderBase {
  /** stable name used in plans, manifests and fallback chains, e.g. "gemini", "template", "lyria", "piper" */
  readonly name: string;
  readonly capability: Capability;
  /** true for local/deterministic providers (no API spend) */
  readonly local: boolean;
  /** model id (from configuration) or a version tag for local code */
  readonly model: string;
  /** can this provider run right now (credentials, binaries, enabled flags) — must not spend money */
  available(): Promise<{ ok: boolean; reason?: string }>;
}

/* ---------------------------------------------------------------- director ------------------------ */

/** The minimal context the runtime director receives (token budget: no repo, no history dumps). */
export interface DirectorInput {
  product: ProductProfile;
  /** facts by id, short — the only material claims may cite */
  facts: { id: string; kind: string; text: string }[];
  price?: { amount: number; currency: string; factId: string };
  brand: Pick<
    BrandProfile,
    "brandName" | "visualStyle" | "musicStyle" | "forbiddenPhrases" | "preferredCTA"
  > & {
    voicePersona: Pick<VoicePersona, "id" | "description">;
  };
  platform: Pick<PlatformProfile, "id" | "durationMs" | "avgShotMs" | "maxOverlayWords">;
  locale: LocaleTag;
  market: string;
  targetDurationS: number;
  objective: "conversion" | "consideration" | "awareness";
  /** whitelisted options the decision may use */
  options: {
    shotPresets: readonly string[];
    hookStrategies: readonly string[];
    environments: readonly string[];
    sfxKinds: readonly string[];
    musicGenres: readonly string[];
    musicMoods: readonly string[];
  };
  /** retrieved assets worth reusing (ids + one-line descriptions) */
  assets: { id: string; kind: string; description: string }[];
  /** best-performing hooks / structures for this brand+category so far (may be empty) */
  history: { hookStrategy: string; score: number; note?: string }[];
  /** forced hook strategy (A/B variants) */
  hookStrategy?: string;
}

export interface DirectorProvider extends ProviderBase {
  readonly capability: "director";
  estimateMicros(input: DirectorInput): number;
  direct(
    input: DirectorInput,
    ctx: CallContext,
  ): Promise<{ decision: DirectorDecision; promptVersion: string }>;
}

/* ---------------------------------------------------------------- product analysis ---------------- */

export interface ProductAnalyzer extends ProviderBase {
  readonly capability: "product_analysis";
  estimateMicros(source: ProductSource): number;
  analyze(source: ProductSource, ctx: CallContext): Promise<ProductProfile>;
}

/* ---------------------------------------------------------------- transcreation ------------------- */

export interface TranscreationRequest {
  master: LocaleCopy;
  targets: { locale: LocaleTag; market: string }[];
  product: ProductProfile;
  /** localized product names from the source, terminology per locale */
  productNames: Record<string, string>;
  facts: { id: string; kind: string; text: string }[];
  brand: Pick<BrandProfile, "brandName" | "forbiddenPhrases" | "preferredCTA" | "disclosure">;
  /** max characters per slot (on-screen fit) */
  limits: Record<string, number>;
}

export interface TranscreationProvider extends ProviderBase {
  readonly capability: "transcreation";
  estimateMicros(req: TranscreationRequest): number;
  /** adapts (not word-for-word translates) the master copy to each market */
  transcreate(req: TranscreationRequest, ctx: CallContext): Promise<LocaleCopy[]>;
}

/* ---------------------------------------------------------------- music --------------------------- */

export interface MusicProvider extends ProviderBase {
  readonly capability: "music";
  /** true when generated music may be used commercially (licence checked in configuration) */
  readonly commercialUse: boolean;
  estimateMicros(intent: MusicIntent): number;
  compose(
    intent: MusicIntent,
    ctx: CallContext,
  ): Promise<{ path: string; durationMs: number; bpm: number; license: string; cached: boolean }>;
}

/* ---------------------------------------------------------------- voice --------------------------- */

export interface VoiceRequest {
  text: string;
  locale: LocaleTag;
  persona: VoicePersona;
  /** 0.7–1.4 */
  pace: number;
  /** natural-language delivery direction */
  style: string;
}

export interface VoiceResult {
  path: string;
  durationMs: number;
  /** word timings relative to the start of this clip, when the provider returns them */
  words?: WordTime[];
  voice: string;
  characters: number;
  cached: boolean;
}

export interface VoiceProvider extends ProviderBase {
  readonly capability: "voice";
  supportsLocale(locale: LocaleTag): boolean;
  estimateMicros(req: VoiceRequest): number;
  speak(req: VoiceRequest, ctx: CallContext): Promise<VoiceResult>;
}

/* ---------------------------------------------------------------- transcription ------------------- */

export interface TranscriptionProvider extends ProviderBase {
  readonly capability: "transcription";
  estimateMicros(audioMs: number): number;
  /** word-level timestamps; `expectedText` enables forced alignment where supported */
  transcribe(
    req: { path: string; locale: LocaleTag; expectedText?: string; durationMs: number },
    ctx: CallContext,
  ): Promise<{ words: WordTime[]; exact: boolean }>;
}

/* ---------------------------------------------------------------- sfx ----------------------------- */

export interface SfxProvider extends ProviderBase {
  readonly capability: "sfx";
  has(kind: SfxKind): boolean;
  estimateMicros(kind: SfxKind): number;
  get(
    req: { kind: SfxKind; seed: string; durationMs?: number },
    ctx: CallContext,
  ): Promise<{ path: string; cached: boolean }>;
}

/* ---------------------------------------------------------------- image --------------------------- */

/** AI images are for plates / storyboards / stylised graphics — NEVER for the product itself. */
export type ImagePurpose = "background_plate" | "storyboard" | "graphic_element" | "scene_reference";

export interface ImageGenRequest {
  purpose: ImagePurpose;
  prompt: string;
  aspect: "9:16" | "1:1" | "16:9";
  /** optional style references (paths) — product photos may be used as reference for a plate only */
  references?: string[];
  seed: string;
}

export interface ImageGenProvider extends ProviderBase {
  readonly capability: "image";
  estimateMicros(req: ImageGenRequest): number;
  generate(
    req: ImageGenRequest,
    ctx: CallContext,
  ): Promise<{ path: string; width: number; height: number; cached: boolean }>;
}

/* ---------------------------------------------------------------- embeddings ---------------------- */

export type EmbedItem = {
  id: string;
  text?: string;
  imagePath?: string;
  audioPath?: string;
  videoPath?: string;
};

export interface EmbeddingProvider extends ProviderBase {
  readonly capability: "embedding";
  readonly dimensions: number;
  readonly modalities: readonly ("text" | "image" | "audio" | "video")[];
  estimateMicros(items: EmbedItem[]): number;
  embed(items: EmbedItem[], ctx: CallContext): Promise<{ id: string; vector: number[] }[]>;
}

/* ---------------------------------------------------------------- generative video ---------------- */

export interface GenerativeVideoRequest {
  prompt: string;
  seconds: number;
  aspect: "9:16";
  /** first frame (e.g. a Blender plate) so the shot matches the reel */
  firstFramePath?: string;
  seed: string;
}

export interface GenerativeVideoProvider extends ProviderBase {
  readonly capability: "generative_video";
  estimateMicros(req: GenerativeVideoRequest): number;
  generate(
    req: GenerativeVideoRequest,
    ctx: CallContext,
  ): Promise<{ path: string; durationMs: number; cached: boolean }>;
}

/* ---------------------------------------------------------------- visual QA ----------------------- */

export interface VisualQaRequest {
  frames: { atMs: number; path: string }[];
  productName: string;
  ctaText: string;
  locale: LocaleTag;
}

export interface VisualQaResult {
  score: number;
  issues: string[];
  rerenderRequired: boolean;
  productVisible: boolean;
  productCut: boolean;
  ctaReadable: boolean;
}

export interface VisualQaProvider extends ProviderBase {
  readonly capability: "visual_qa";
  estimateMicros(req: VisualQaRequest): number;
  assess(req: VisualQaRequest, ctx: CallContext): Promise<VisualQaResult>;
}

export type AnyProvider =
  | DirectorProvider
  | ProductAnalyzer
  | TranscreationProvider
  | MusicProvider
  | VoiceProvider
  | TranscriptionProvider
  | SfxProvider
  | ImageGenProvider
  | EmbeddingProvider
  | GenerativeVideoProvider
  | VisualQaProvider;
