import fsp from "node:fs/promises";
import path from "node:path";
import { getPrice, musicCostMicros, tokenCostMicros, type Env } from "@cre/config";
import { FatalError, LogEvent, ProviderError, sleep as abortableSleep, type Logger } from "@cre/shared";
import { safeUrl } from "../http.ts";
import {
  cloudTtsBilledCharacters,
  cloudTtsCostMicros,
  estimateEmbedMicros,
  estimateGenerateMicros,
  estimateImageMicros,
  estimateMusicMicros,
  estimateSpeechMicros,
  estimateTranscriptionMicros,
  estimateVideoMicros,
  geminiUsage,
  hasUsage,
  isCloudSttModel,
  textTokens,
  transcriptionCostMicros,
  usageCostMicros,
  type UsageMetadata,
} from "./cost.ts";
import { normalizeVector, planEmbedBatches } from "./embed.ts";
import {
  MEDIA_RESOLUTION,
  THINKING_LEVEL,
  assertModelId,
  assertNotBlocked,
  billedError,
  candidateText,
  inlineOutputs,
  modelUrl,
  parseJsonText,
  toRestParts,
  userContent,
  type GenerateContentResponse,
} from "./gemini.ts";
import {
  InlineBudget,
  imageDimensions,
  mimeTypeOf,
  parseWav,
  pcmToWav,
  readInline,
  toWav,
  wavPcm,
} from "./media.ts";
import { sharedGoogleRateLimiter, type RateLimiter } from "./rate-limit.ts";
import {
  chunkMarksSsml,
  cloudTtsBody,
  geminiTtsBody,
  wordsFromTimepoints,
  type CloudTtsResponse,
} from "./speech.ts";
import {
  STT_SYNC_MAX_BYTES,
  STT_SYNC_MAX_MS,
  geminiTranscribeBody,
  geminiTranscriptionWords,
  sttRecognizeBody,
  sttRecognizeUrl,
  sttWords,
  type SttRecognizeResponse,
} from "./transcribe.ts";
import { GOOGLE_PROVIDER, GoogleTransport, type GoogleAuth } from "./transport.ts";
import type {
  CloudTtsMarkRequest,
  GeminiGenerateRequest,
  GeminiGenerateResult,
  GeminiPart,
  GeminiUsage,
  GoogleAI,
  GoogleEmbedItem,
  GoogleImageRequest,
  GoogleMusicRequest,
  GoogleSpeechRequest,
  GoogleTranscriptionRequest,
  GoogleVideoRequest,
  TimedWord,
} from "./types.ts";
import {
  agentPlatformModelUrl,
  assertOperationName,
  gcsMediaUrl,
  isGeminiApiHost,
  veoBody,
  veoDurationSeconds,
  veoResult,
  videoSurface,
  type VeoOperation,
  type VideoSurface,
} from "./video.ts";

/*
 * createGoogleAI(env) — the one Google client every capability shares. Construction never fails and never
 * touches the network: a missing key / token / project raises a FatalError when a method that needs it is
 * CALLED. Transport concerns (auth, Retry-After retries, the process-wide RPM bucket, redaction) live in
 * transport.ts; wire formats in gemini.ts / speech.ts / transcribe.ts / embed.ts / video.ts; prices in cost.ts.
 */

export type GoogleEnv = Pick<
  Env,
  | "GOOGLE_API_KEY"
  | "GOOGLE_GENAI_BASE_URL"
  | "GOOGLE_CLOUD_ACCESS_TOKEN"
  | "GOOGLE_CLOUD_PROJECT"
  | "GOOGLE_CLOUD_LOCATION"
  | "GOOGLE_MAX_RPM"
>;

export interface GoogleAIDeps {
  fetch?: typeof fetch;
  logger?: Logger;
  /** defaults to the process-wide bucket sized by GOOGLE_MAX_RPM */
  rateLimiter?: RateLimiter;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** pricing date (scheduled price changes) */
  now?: () => Date;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxRetryDelayMs?: number;
  /** raw bytes of inline media per Gemini API request (default 14 MB ≈ 19 MB base64 < the 20 MB limit) */
  maxInlineBytes?: number;
  cloudTtsBaseUrl?: string;
  /** Speech-to-Text v2 location (default derived from GOOGLE_CLOUD_LOCATION; chirp_3 is GA in us / eu) */
  sttLocation?: string;
  /** Agent Platform location for Veo (default GOOGLE_CLOUD_LOCATION, "global" → us-central1 as in Google's samples) */
  videoLocation?: string;
  /** Veo operation poll interval (default 10 s) */
  pollIntervalMs?: number;
}

const DEFAULT_MAX_INLINE_BYTES = 14_000_000;
/** Veo first frames may be up to 20 MB on Agent Platform */
const VEO_MAX_IMAGE_BYTES = 20_000_000;
const VIDEO_MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
/** pre-call input estimate per media part when the API reports no usage (Gemini 3 high resolution) */
const MEDIA_PART_TOKENS: Record<"low" | "medium" | "high", number> = { low: 280, medium: 560, high: 1120 };

/** chirp_3 runs in the `us` / `eu` multi-regions (GA); regional ids pass through unchanged. */
export function defaultSttLocation(cloudLocation: string): string {
  if (cloudLocation === "global" || cloudLocation.startsWith("us")) return "us";
  if (cloudLocation === "eu" || cloudLocation.startsWith("europe")) return "eu";
  return cloudLocation;
}

export function defaultVideoLocation(cloudLocation: string): string {
  return cloudLocation === "global" ? "us-central1" : cloudLocation;
}

export class GoogleAIClient implements GoogleAI {
  private readonly t: GoogleTransport;
  private readonly log: Logger;
  private readonly baseUrl: string;
  private readonly cloudTtsBaseUrl: string;
  private readonly project: string | undefined;
  private readonly sttLocation: string;
  private readonly videoLocation: string;
  private readonly maxInlineBytes: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => Date;

  constructor(env: GoogleEnv, deps: GoogleAIDeps = {}) {
    this.t = new GoogleTransport({
      apiKey: env.GOOGLE_API_KEY,
      cloudToken: env.GOOGLE_CLOUD_ACCESS_TOKEN,
      cloudProject: env.GOOGLE_CLOUD_PROJECT,
      rateLimiter: deps.rateLimiter ?? sharedGoogleRateLimiter(env.GOOGLE_MAX_RPM),
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      ...(deps.maxAttempts !== undefined ? { maxAttempts: deps.maxAttempts } : {}),
      ...(deps.baseBackoffMs !== undefined ? { baseBackoffMs: deps.baseBackoffMs } : {}),
      ...(deps.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: deps.maxRetryDelayMs } : {}),
    });
    this.log = this.t.logger;
    this.baseUrl = env.GOOGLE_GENAI_BASE_URL.replace(/\/+$/, "");
    this.cloudTtsBaseUrl = (deps.cloudTtsBaseUrl ?? "https://texttospeech.googleapis.com").replace(
      /\/+$/,
      "",
    );
    this.project = env.GOOGLE_CLOUD_PROJECT;
    this.sttLocation = deps.sttLocation ?? defaultSttLocation(env.GOOGLE_CLOUD_LOCATION);
    this.videoLocation = deps.videoLocation ?? defaultVideoLocation(env.GOOGLE_CLOUD_LOCATION);
    this.maxInlineBytes = deps.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
    this.pollIntervalMs = deps.pollIntervalMs ?? 10_000;
    this.sleep = deps.sleep ?? abortableSleep;
    this.now = deps.now ?? (() => new Date());
  }

  get hasApiKey(): boolean {
    return this.t.hasApiKey;
  }

  get hasCloudToken(): boolean {
    return this.t.hasCloudToken;
  }

  get hasCloudProject(): boolean {
    return this.t.hasCloudProject;
  }

  /* ================================================================ Gemini generateContent ========= */

  async generate(req: GeminiGenerateRequest): Promise<GeminiGenerateResult> {
    const model = assertModelId(req.model);
    const label = labelOf("generate", req.label, model);
    const parts = await toRestParts(req.parts, new InlineBudget(this.maxInlineBytes));
    const generationConfig: Record<string, unknown> = {};
    if (req.jsonSchema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseJsonSchema = req.jsonSchema;
    }
    if (req.thinkingLevel)
      generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVEL[req.thinkingLevel] };
    if (req.maxOutputTokens) generationConfig.maxOutputTokens = req.maxOutputTokens;
    if (req.mediaResolution) generationConfig.mediaResolution = MEDIA_RESOLUTION[req.mediaResolution];
    const body = {
      contents: userContent(parts),
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    };
    const { data, latencyMs } = await this.callGemini(model, "generateContent", body, label, req, 120_000);
    const cost = this.tokenCost(model, data.usageMetadata, () =>
      estimateGenerateMicros(model, estimatePartsTokens(req), req.maxOutputTokens ?? 2_048),
    );
    assertNotBlocked(data, label, cost.costMicros);
    const text = candidateText(data);
    const finishReason = data.candidates?.[0]?.finishReason;
    let json: unknown;
    if (req.jsonSchema) {
      try {
        json = parseJsonText(text);
      } catch {
        throw billedError(`${label}: invalid JSON from the model (finishReason ${finishReason ?? "?"})`, {
          code: "INVALID_OUTPUT",
          retryable: false,
          costMicros: cost.costMicros,
          details: { finishReason },
        });
      }
    }
    const usage = geminiUsage(data.usageMetadata);
    this.logCost(label, model, cost, latencyMs, usage);
    return {
      text,
      ...(req.jsonSchema ? { json } : {}),
      usage,
      model,
      latencyMs,
      ...(finishReason ? { finishReason } : {}),
      costMicros: cost.costMicros,
      ...(cost.estimated ? { costEstimated: true } : {}),
    };
  }

  /* ================================================================ image ========================== */

  async generateImage(req: GoogleImageRequest): ReturnType<GoogleAI["generateImage"]> {
    const model = assertModelId(req.model);
    const label = labelOf("image", req.label, model);
    const refs = await toRestParts(
      (req.references ?? []).map((file): GeminiPart => ({ file })),
      new InlineBudget(this.maxInlineBytes),
    );
    const body = {
      contents: userContent([{ text: req.prompt }, ...refs]),
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio: req.aspectRatio, ...(req.imageSize ? { imageSize: req.imageSize } : {}) },
      },
    };
    const { data, latencyMs } = await this.callGemini(model, "generateContent", body, label, req, 180_000);
    const cost = this.tokenCost(model, data.usageMetadata, () =>
      estimateImageMicros(model, req.imageSize ?? "1K", refs.length),
    );
    assertNotBlocked(data, label, cost.costMicros);
    const image = inlineOutputs(data).find((o) => o.mimeType.startsWith("image/"));
    if (!image) {
      throw billedError(
        `${label}: no image returned (finishReason ${data.candidates?.[0]?.finishReason ?? "?"})`,
        {
          code: "NO_IMAGE",
          retryable: true,
          costMicros: cost.costMicros,
        },
      );
    }
    const dims = imageDimensions(image.data);
    const text = candidateText(data).trim();
    const usage = geminiUsage(data.usageMetadata);
    this.logCost(label, model, cost, latencyMs, usage);
    return {
      bytes: image.data,
      mimeType: image.mimeType,
      ...(dims ?? {}),
      costMicros: cost.costMicros,
      model,
      ...(text ? { text } : {}),
      usage,
      latencyMs,
      ...(cost.estimated ? { costEstimated: true } : {}),
    };
  }

  /* ================================================================ music (Lyria) ================= */

  async generateMusic(req: GoogleMusicRequest): ReturnType<GoogleAI["generateMusic"]> {
    const model = assertModelId(req.model);
    const label = labelOf("music", req.label, model);
    const refs = await toRestParts(
      (req.references ?? []).map((file): GeminiPart => ({ file })),
      new InlineBudget(this.maxInlineBytes),
    );
    const body = {
      contents: userContent([{ text: req.prompt }, ...refs]),
      generationConfig: { responseModalities: ["AUDIO", "TEXT"] },
    };
    const { data, latencyMs } = await this.callGemini(model, "generateContent", body, label, req, 300_000);
    // Lyria is billed per generated song, whatever the token usage says
    const cost = { costMicros: musicCostMicros(GOOGLE_PROVIDER, model, { count: 1 }), estimated: false };
    assertNotBlocked(data, label, cost.costMicros);
    const audio = inlineOutputs(data).find((o) => o.mimeType.startsWith("audio/"));
    if (!audio) {
      throw billedError(
        `${label}: no audio returned (finishReason ${data.candidates?.[0]?.finishReason ?? "?"})`,
        {
          code: "NO_AUDIO",
          retryable: true,
          costMicros: cost.costMicros,
        },
      );
    }
    const text = candidateText(data).trim();
    const usage = geminiUsage(data.usageMetadata);
    this.logCost(label, model, cost, latencyMs, usage);
    return {
      bytes: audio.data,
      mimeType: audio.mimeType,
      ...(text ? { text } : {}),
      costMicros: cost.costMicros,
      model,
      usage,
      latencyMs,
    };
  }

  /* ================================================================ Gemini TTS ===================== */

  async synthesizeSpeech(req: GoogleSpeechRequest): ReturnType<GoogleAI["synthesizeSpeech"]> {
    const model = assertModelId(req.model);
    const label = labelOf("tts", req.label, model);
    if (!req.text.trim()) throw new FatalError(`${label}: empty text`);
    const body = geminiTtsBody({ ...req, model });
    const { data, latencyMs } = await this.callGemini(model, "generateContent", body, label, req, 120_000);
    const audio = inlineOutputs(data).find((o) => o.mimeType.toLowerCase().startsWith("audio/"));
    const { wav, sampleRate } = audio ? toWav(audio.data, audio.mimeType) : { wav: undefined, sampleRate: 0 };
    const durationMs = wav ? (parseWav(wav)?.durationMs ?? 0) : 0;
    const cost = this.tokenCost(model, data.usageMetadata, () => ttsCostFromDuration(model, req, durationMs));
    assertNotBlocked(data, label, cost.costMicros);
    if (!wav || durationMs <= 0) {
      throw billedError(`${label}: no audio returned`, {
        code: "NO_AUDIO",
        retryable: true,
        costMicros: cost.costMicros,
      });
    }
    const usage = geminiUsage(data.usageMetadata);
    this.logCost(label, model, cost, latencyMs, usage);
    return {
      wav,
      sampleRate,
      costMicros: cost.costMicros,
      model,
      usage,
      latencyMs,
      ...(cost.estimated ? { costEstimated: true } : {}),
    };
  }

  /* ================================================================ Cloud TTS + SSML marks ========= */

  async synthesizeWithMarks(req: CloudTtsMarkRequest): ReturnType<GoogleAI["synthesizeWithMarks"]> {
    const label = labelOf("cloudtts", req.label, req.voiceName);
    if (!/^[A-Za-z0-9-]{2,64}$/.test(req.voiceName)) throw new FatalError(`${label}: invalid voice name`);
    const words = req.words.map((w) => w.trim()).filter(Boolean);
    if (!words.length) throw new FatalError(`${label}: no words`);
    const sampleRateHertz = req.sampleRateHertz ?? 48_000;
    const pcm: Buffer[] = [];
    const timed: TimedWord[] = [];
    let format: { sampleRate: number; channels: number; bitsPerSample: number } | undefined;
    let offsetMs = 0;
    let characters = 0;
    let latencyMs = 0;
    for (const chunk of chunkMarksSsml(words)) {
      characters += cloudTtsBilledCharacters(chunk.ssml);
      const { data, latencyMs: ms } = await this.t.requestJson<CloudTtsResponse>({
        method: "POST",
        url: `${this.cloudTtsBaseUrl}/v1beta1/text:synthesize`,
        auth: "cloud_token",
        body: cloudTtsBody({
          ssml: chunk.ssml,
          voiceName: req.voiceName,
          languageCode: req.languageCode,
          sampleRateHertz,
          speakingRate: req.speakingRate,
        }),
        timeoutMs: req.timeoutMs ?? 60_000,
        signal: req.signal,
        label,
        model: req.voiceName,
      });
      latencyMs += ms;
      const spent = cloudTtsCostMicros(req.voiceName, characters);
      const raw = Buffer.from(data.audioContent ?? "", "base64");
      const rate = data.audioConfig?.sampleRateHertz ?? sampleRateHertz;
      const parsed = wavPcm(raw) ?? wavPcm(pcmToWav(raw, rate));
      if (!parsed || parsed.info.dataBytes === 0) {
        throw billedError(`${label}: no audio returned`, {
          code: "NO_AUDIO",
          retryable: true,
          costMicros: spent,
        });
      }
      const { info } = parsed;
      if (format && (format.sampleRate !== info.sampleRate || format.channels !== info.channels)) {
        throw billedError(`${label}: audio format changed between chunks`, {
          code: "INVALID_OUTPUT",
          retryable: false,
          costMicros: spent,
        });
      }
      format ??= { sampleRate: info.sampleRate, channels: info.channels, bitsPerSample: info.bitsPerSample };
      const chunkWords = wordsFromTimepoints(
        words,
        chunk.from,
        chunk.to,
        data.timepoints,
        info.durationMs,
        offsetMs,
      );
      if (!chunkWords) {
        throw billedError(`${label}: voice ${req.voiceName} returned no SSML <mark> timepoints`, {
          code: "NO_TIMEPOINTS",
          retryable: false,
          costMicros: spent,
        });
      }
      timed.push(...chunkWords);
      pcm.push(parsed.pcm);
      offsetMs += info.durationMs;
    }
    const f = format ?? { sampleRate: sampleRateHertz, channels: 1, bitsPerSample: 16 };
    const audio = pcmToWav(Buffer.concat(pcm), f.sampleRate, f.channels, f.bitsPerSample);
    const cost = { costMicros: cloudTtsCostMicros(req.voiceName, characters), estimated: false };
    this.logCost(label, req.voiceName, cost, latencyMs, undefined, { characters });
    return {
      audio,
      mimeType: "audio/wav",
      words: timed,
      costMicros: cost.costMicros,
      characters,
      sampleRate: f.sampleRate,
      durationMs: offsetMs,
      latencyMs,
    };
  }

  /* ================================================================ transcription ================== */

  async transcribe(req: GoogleTranscriptionRequest): ReturnType<GoogleAI["transcribe"]> {
    const model = assertModelId(req.model);
    const label = labelOf("transcribe", req.label, model);
    const mimeType = mimeTypeOf(req.audioPath);
    const stat = await fsp.stat(req.audioPath).catch((err: unknown) => {
      throw new FatalError(
        `${label}: cannot read ${path.basename(req.audioPath)}: ${(err as Error).message}`,
      );
    });
    return isCloudSttModel(model)
      ? await this.transcribeStt(req, model, label, stat.size)
      : await this.transcribeGemini(req, model, label, mimeType);
  }

  private async transcribeGemini(
    req: GoogleTranscriptionRequest,
    model: string,
    label: string,
    mimeType: string,
  ): ReturnType<GoogleAI["transcribe"]> {
    const { data: audio } = await readInline(req.audioPath, new InlineBudget(this.maxInlineBytes), mimeType);
    const audioMs = req.durationMs ?? audioDurationMs(audio);
    const body = geminiTranscribeBody({
      audio: { mimeType, data: audio.toString("base64") },
      languageCode: req.languageCode,
    });
    const { data, latencyMs } = await this.callGemini(model, "generateContent", body, label, req, 180_000);
    const cost = transcriptionCostMicros(
      model,
      { ...(data.usageMetadata ? { usage: data.usageMetadata } : {}) },
      audioMs,
    );
    assertNotBlocked(data, label, cost.costMicros);
    const { words, text } = geminiTranscriptionWords(data);
    if (!words.length) {
      throw billedError(`${label}: no word timestamps returned`, {
        code: "NO_WORDS",
        retryable: false,
        costMicros: cost.costMicros,
      });
    }
    const usage = geminiUsage(data.usageMetadata);
    this.logCost(label, model, cost, latencyMs, usage, { audioMs });
    return {
      words,
      text,
      costMicros: cost.costMicros,
      model,
      usage,
      latencyMs,
      ...(cost.estimated ? { costEstimated: true } : {}),
    };
  }

  private async transcribeStt(
    req: GoogleTranscriptionRequest,
    model: string,
    label: string,
    sizeBytes: number,
  ): ReturnType<GoogleAI["transcribe"]> {
    if (!this.project) throw new FatalError(`${label}: GOOGLE_CLOUD_PROJECT is not configured`);
    if (sizeBytes > STT_SYNC_MAX_BYTES) {
      throw new FatalError(
        `${label}: ${(sizeBytes / 1e6).toFixed(1)} MB exceeds the 10 MB sync Recognize limit`,
      );
    }
    const audio = await fsp.readFile(req.audioPath);
    const audioMs = req.durationMs ?? audioDurationMs(audio);
    if (audioMs > STT_SYNC_MAX_MS) {
      throw new FatalError(`${label}: ${audioMs} ms of audio exceeds the 60 s sync Recognize limit`);
    }
    // autoDecodingConfig detects WAV / MP3 / FLAC / OGG from the bytes
    const { data, latencyMs } = await this.t.requestJson<SttRecognizeResponse>({
      method: "POST",
      url: sttRecognizeUrl(this.project, this.sttLocation),
      auth: "cloud_token",
      body: sttRecognizeBody({ model, languageCode: req.languageCode, content: audio.toString("base64") }),
      timeoutMs: req.timeoutMs ?? 120_000,
      signal: req.signal,
      label,
      model,
    });
    const parsed = sttWords(data);
    const cost = transcriptionCostMicros(
      model,
      parsed.billedSeconds !== undefined ? { billedSeconds: parsed.billedSeconds } : {},
      audioMs,
    );
    if (!parsed.words.length) {
      throw billedError(`${label}: no word timestamps returned`, {
        code: "NO_WORDS",
        retryable: false,
        costMicros: cost.costMicros,
      });
    }
    this.logCost(label, model, cost, latencyMs, undefined, { audioMs });
    return {
      words: parsed.words,
      text: parsed.text,
      costMicros: cost.costMicros,
      model,
      latencyMs,
      ...(cost.estimated ? { costEstimated: true } : {}),
    };
  }

  /* ================================================================ embeddings ===================== */

  async embed(req: Parameters<GoogleAI["embed"]>[0]): ReturnType<GoogleAI["embed"]> {
    const model = assertModelId(req.model);
    const label = labelOf("embed", req.label, model);
    if (!req.items.length) return { vectors: [], costMicros: 0 };
    const role = req.role ?? "document";
    const batches = await planEmbedBatches(req.items, {
      model,
      dimensions: req.dimensions,
      role,
      maxInlineBytes: this.maxInlineBytes,
    });
    const byId = new Map(req.items.map((i) => [i.id, i]));
    const vectors: { id: string; vector: number[] }[] = [];
    let costMicros = 0;
    let estimated = false;
    let latencyMs = 0;
    let inputTokens = 0;
    for (const batch of batches) {
      const { data, latencyMs: ms } = await this.t.requestJson<{
        embeddings?: { values?: number[] }[];
        usageMetadata?: UsageMetadata;
      }>({
        method: "POST",
        url: modelUrl(this.baseUrl, model, "batchEmbedContents"),
        auth: "api_key",
        body: { requests: batch.requests },
        timeoutMs: req.timeoutMs ?? 60_000,
        signal: req.signal,
        label,
        model,
      });
      latencyMs += ms;
      const batchItems = batch.ids.map((id) => byId.get(id)).filter((i): i is GoogleEmbedItem => Boolean(i));
      const cost = this.tokenCost(model, data.usageMetadata, () => estimateEmbedMicros(model, batchItems));
      costMicros += cost.costMicros;
      estimated ||= cost.estimated;
      inputTokens += data.usageMetadata?.promptTokenCount ?? 0;
      const embeddings = data.embeddings ?? [];
      if (embeddings.length !== batch.ids.length) {
        throw billedError(`${label}: ${embeddings.length} embeddings for ${batch.ids.length} inputs`, {
          code: "INVALID_OUTPUT",
          retryable: true,
          costMicros,
        });
      }
      embeddings.forEach((e, i) => {
        const values = e.values ?? [];
        if (values.length < req.dimensions) {
          throw billedError(`${label}: ${values.length}-d vector, expected ${req.dimensions}`, {
            code: "INVALID_OUTPUT",
            retryable: false,
            costMicros,
          });
        }
        vectors.push({ id: batch.ids[i] ?? "", vector: normalizeVector(values, req.dimensions) });
      });
    }
    const usage: GeminiUsage = { inputTokens, outputTokens: 0, thoughtsTokens: 0, cachedTokens: 0 };
    this.logCost(label, model, { costMicros, estimated }, latencyMs, usage, { items: req.items.length });
    return { vectors, costMicros, usage, latencyMs, ...(estimated ? { costEstimated: true } : {}) };
  }

  /* ================================================================ Veo ============================ */

  async generateVideo(req: GoogleVideoRequest): ReturnType<GoogleAI["generateVideo"]> {
    const model = assertModelId(req.model);
    const label = labelOf("video", req.label, model);
    const surface = videoSurface(model);
    const auth: GoogleAuth = surface === "gemini_api" ? "api_key" : "cloud_token";
    if (surface === "agent_platform" && !this.project) {
      throw new FatalError(`${label}: GOOGLE_CLOUD_PROJECT is not configured (Agent Platform Veo)`);
    }
    const durationSeconds = veoDurationSeconds(req.seconds);
    // the Gemini API always generates audio (and bills it); Agent Platform can switch it off
    const withAudio = surface === "gemini_api" ? true : (req.generateAudio ?? false);
    const costMicros = estimateVideoMicros(model, durationSeconds, withAudio, req.resolution);
    const started = Date.now();
    const deadline = started + (req.timeoutMs ?? 600_000);
    let name = req.operationName ? assertOperationName(surface, req.operationName) : undefined;
    if (!name) {
      const image = req.firstFramePath
        ? await readInline(req.firstFramePath, new InlineBudget(VEO_MAX_IMAGE_BYTES))
        : undefined;
      const body = veoBody(surface, {
        prompt: req.prompt,
        durationSeconds,
        aspectRatio: req.aspectRatio,
        image: image
          ? { bytesBase64Encoded: image.data.toString("base64"), mimeType: image.mimeType }
          : undefined,
        negativePrompt: req.negativePrompt,
        resolution: req.resolution,
        generateAudio: withAudio,
        seed: surface === "agent_platform" ? req.seed : undefined,
      });
      const { data } = await this.t.requestJson<VeoOperation>({
        method: "POST",
        url:
          surface === "gemini_api"
            ? modelUrl(this.baseUrl, model, "predictLongRunning")
            : agentPlatformModelUrl(this.project ?? "", this.videoLocation, model, "predictLongRunning"),
        auth,
        body,
        timeoutMs: 60_000,
        signal: req.signal,
        label,
        model,
        // a retried submit could start (and bill) a second generation
        retry: false,
      });
      if (!data.name) throw new ProviderError(GOOGLE_PROVIDER, `${label}: no operation name returned`);
      name = assertOperationName(surface, data.name);
      this.log.info({ label, model, operation: name }, "veo operation started");
      await req.onOperation?.(name);
      await this.sleep(this.pollIntervalMs, req.signal);
    }
    let op: VeoOperation;
    for (;;) {
      op = await this.pollVideo(surface, model, name, label, req.signal);
      if (op.done) break;
      if (Date.now() + this.pollIntervalMs > deadline) {
        throw new ProviderError(GOOGLE_PROVIDER, `${label}: still running after ${Date.now() - started} ms`, {
          code: "TIMEOUT",
          retryable: true,
          charged: true,
          details: { operationName: name },
        });
      }
      await this.sleep(this.pollIntervalMs, req.signal);
    }
    if (op.error) {
      const retryable = [4, 8, 10, 13, 14].includes(op.error.code ?? 0);
      throw new ProviderError(
        GOOGLE_PROVIDER,
        `${label}: operation failed: ${op.error.message ?? op.error.status ?? "?"}`,
        {
          code: op.error.code === 3 ? "INVALID_REQUEST" : "PROVIDER_ERROR",
          retryable,
          details: { operationName: name, googleStatus: op.error.status },
        },
      );
    }
    const result = veoResult(op);
    let bytes: Buffer;
    let mimeType = "video/mp4";
    switch (result.kind) {
      case "bytes":
        bytes = result.data;
        mimeType = result.mimeType;
        break;
      case "uri":
        bytes = await this.downloadGeminiFile(result.uri, label, model, req.signal);
        mimeType = result.mimeType;
        break;
      case "gcs":
        bytes = (
          await this.t.request({
            method: "GET",
            url: gcsMediaUrl(result.uri),
            auth: "cloud_token",
            timeoutMs: 120_000,
            signal: req.signal,
            label: `${label} download`,
            model,
            maxResponseBytes: VIDEO_MAX_DOWNLOAD_BYTES,
          })
        ).body;
        mimeType = result.mimeType;
        break;
      case "filtered":
        throw billedError(
          `${label}: video blocked by safety filters (${result.reasons.join("; ").slice(0, 200)})`,
          {
            code: "CONTENT_BLOCKED",
            retryable: false,
            costMicros: 0,
            details: { operationName: name },
          },
        );
      case "empty":
        throw new ProviderError(GOOGLE_PROVIDER, `${label}: operation finished without a video`, {
          retryable: true,
          details: { operationName: name },
        });
    }
    const latencyMs = Date.now() - started;
    this.logCost(label, model, { costMicros, estimated: false }, latencyMs, undefined, {
      videoSeconds: durationSeconds,
    });
    return {
      bytes,
      durationMs: durationSeconds * 1000,
      costMicros,
      model,
      mimeType,
      operationName: name,
      latencyMs,
    };
  }

  private async pollVideo(
    surface: VideoSurface,
    model: string,
    name: string,
    label: string,
    signal: AbortSignal | undefined,
  ): Promise<VeoOperation> {
    const poll =
      surface === "gemini_api"
        ? { method: "GET" as const, url: `${this.baseUrl}/v1beta/${name}`, auth: "api_key" as const }
        : {
            method: "POST" as const,
            url: agentPlatformModelUrl(
              this.project ?? "",
              this.videoLocation,
              model,
              "fetchPredictOperation",
            ),
            auth: "cloud_token" as const,
            body: { operationName: name },
          };
    const { data } = await this.t.requestJson<VeoOperation>({
      ...poll,
      timeoutMs: 30_000,
      signal,
      label: `${label} poll`,
      model,
    });
    return data;
  }

  /** Gemini API file download: the key goes to the Gemini API host only — never to the redirect target. */
  private async downloadGeminiFile(
    uri: string,
    label: string,
    model: string,
    signal: AbortSignal | undefined,
  ): Promise<Buffer> {
    if (!isGeminiApiHost(uri, this.baseUrl)) {
      throw new FatalError(`${label}: refusing to send the API key to ${safeUrl(uri)}`);
    }
    const common = {
      method: "GET" as const,
      timeoutMs: 120_000,
      signal,
      model,
      maxResponseBytes: VIDEO_MAX_DOWNLOAD_BYTES,
    };
    const first = await this.t.request({
      ...common,
      url: uri,
      auth: "api_key",
      label: `${label} download`,
      redirect: "manual",
    });
    if (first.status < 300 || first.status >= 400) return first.body;
    const location = first.headers.get("location");
    const next = location ? new URL(location, uri) : undefined;
    if (next?.protocol !== "https:") {
      throw new ProviderError(GOOGLE_PROVIDER, `${label}: download redirect without an https location`);
    }
    return (await this.t.request({ ...common, url: next.href, auth: "none", label: `${label} download` }))
      .body;
  }

  /* ================================================================ estimates ====================== */

  estimateGenerateMicros(model: string, inputTokens: number, outputTokens: number): number {
    return estimateGenerateMicros(model, inputTokens, outputTokens);
  }

  estimateImageMicros(model: string, imageSize: "1K" | "2K" | "4K", referenceCount = 0): number {
    return estimateImageMicros(model, imageSize, referenceCount);
  }

  estimateMusicMicros(model: string): number {
    return estimateMusicMicros(model);
  }

  estimateSpeechMicros(model: string, characters: number): number {
    return estimateSpeechMicros(model, characters);
  }

  estimateTranscriptionMicros(model: string, audioMs: number): number {
    return estimateTranscriptionMicros(model, audioMs);
  }

  estimateEmbedMicros(model: string, items: GoogleEmbedItem[]): number {
    return estimateEmbedMicros(model, items);
  }

  estimateVideoMicros(model: string, seconds: number, withAudio: boolean): number {
    // Veo bills the generated 4 / 6 / 8 s; the Gemini API always adds audio
    const billed = seconds <= 8 ? veoDurationSeconds(seconds) : seconds;
    return estimateVideoMicros(model, billed, videoSurface(model) === "gemini_api" ? true : withAudio);
  }

  /* ================================================================ internals ====================== */

  private async callGemini(
    model: string,
    method: string,
    body: unknown,
    label: string,
    req: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined },
    defaultTimeoutMs: number,
  ): Promise<{ data: GenerateContentResponse; latencyMs: number }> {
    const { data, latencyMs } = await this.t.requestJson<GenerateContentResponse>({
      method: "POST",
      url: modelUrl(this.baseUrl, model, method),
      auth: "api_key",
      body,
      timeoutMs: req.timeoutMs ?? defaultTimeoutMs,
      signal: req.signal,
      label,
      model,
    });
    return { data, latencyMs };
  }

  /** cost from reported usage; the pre-call estimate (flagged) when the response carried none */
  private tokenCost(
    model: string,
    usage: UsageMetadata | undefined,
    fallback: () => number,
  ): { costMicros: number; estimated: boolean } {
    if (hasUsage(usage)) return { costMicros: usageCostMicros(model, usage, this.now()), estimated: false };
    return { costMicros: fallback(), estimated: true };
  }

  private logCost(
    label: string,
    model: string,
    cost: { costMicros: number; estimated: boolean },
    latencyMs: number,
    usage?: GeminiUsage,
    units?: Record<string, number>,
  ): void {
    this.log.info(
      {
        event: LogEvent.COST,
        label,
        model,
        costMicros: cost.costMicros,
        costEstimated: cost.estimated,
        latencyMs,
        ...(usage
          ? {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              thoughtsTokens: usage.thoughtsTokens,
            }
          : {}),
        ...(units ? { units } : {}),
      },
      "google call",
    );
  }
}

export function createGoogleAI(env: GoogleEnv, deps: GoogleAIDeps = {}): GoogleAIClient {
  return new GoogleAIClient(env, deps);
}

/* ---------------------------------------------------------------- helpers ------------------------ */

function labelOf(surface: string, label: string | undefined, model: string): string {
  return `google.${surface}${label ? ` ${label}` : ""} (${model})`;
}

/** pre-call input tokens of a generate request (only used when the response reports no usage) */
function estimatePartsTokens(req: GeminiGenerateRequest): number {
  const perMedia = MEDIA_PART_TOKENS[req.mediaResolution ?? "high"];
  let n = textTokens(req.system ?? "");
  for (const p of req.parts) n += "text" in p ? textTokens(p.text) : perMedia;
  if (req.jsonSchema) n += textTokens(JSON.stringify(req.jsonSchema));
  return n;
}

/** Gemini TTS cost from the audio length when the response carried no usage (catalog audio tokens / s). */
function ttsCostFromDuration(model: string, req: GoogleSpeechRequest, durationMs: number): number {
  if (durationMs <= 0) return estimateSpeechMicros(model, req.text.length);
  const perSecond = getPrice(GOOGLE_PROVIDER, model, "tokens").audioTokensPerSecond ?? 32;
  return tokenCostMicros(GOOGLE_PROVIDER, model, {
    input: { text: textTokens(req.text + (req.style ?? "")) },
    output: { audio: Math.ceil((durationMs / 1000) * perSecond) },
  });
}

/** WAV duration from its header; otherwise a ~128 kbit/s upper-bound guess from the size. */
function audioDurationMs(buf: Buffer): number {
  return parseWav(buf)?.durationMs ?? Math.ceil((buf.length / 16_000) * 1000);
}
