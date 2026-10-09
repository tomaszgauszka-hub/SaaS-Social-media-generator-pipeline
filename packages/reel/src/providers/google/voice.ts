import fsp from "node:fs/promises";
import path from "node:path";
import type { Env } from "@cre/config";
import { parseWav, type GoogleAI } from "@cre/providers";
import { FatalError } from "@cre/shared";
import type { CallContext, VoiceProvider, VoiceRequest, VoiceResult } from "../../capabilities/types.ts";
import type { LocaleTag } from "../../contracts/ids.ts";
import type { WordTime } from "../../contracts/media.ts";
import type { VoicePersona } from "../../contracts/profiles.ts";
import { cacheKey } from "../../util/cache.ts";
import { cachedCall, paid, promptSafe, recordCall, toWav48k } from "./common.ts";

/*
 * Google voices for the reel:
 *  - GoogleGeminiTtsVoiceProvider — Gemini TTS (natural, style-directable). Returns NO word timings: captions
 *    come from transcription / local alignment.
 *  - GoogleCloudTtsMarksVoiceProvider — Cloud TTS v1beta1 with one SSML <mark> per word: exact word starts, so
 *    no transcription pass is needed (Standard / WaveNet / Neural2 voices only — Chirp 3 HD ignores marks).
 * Both write 16-bit 48 kHz mono WAV into the cache.
 */

export const GEMINI_TTS_VERSION = "gemini-tts/1";
export const CLOUD_TTS_VERSION = "cloudtts-marks/1";
const NS_GEMINI = "google.tts";
const NS_CLOUD = "google.cloudtts";

/** voice names go into a JSON body — still, accept plain identifiers only */
const VOICE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Languages documented for Gemini TTS (speech-generation language table + SpeechConfig.languageCode values;
 * Gemini 3.8 Flash TTS lists 130+, this is the subset Google names explicitly).
 */
export const GEMINI_TTS_LANGUAGES: ReadonlySet<string> = new Set([
  "ar", "bn", "de", "en", "es", "fr", "hi", "id", "it", "ja", "ko", "mr", "nl", "pl", "pt", "ro", "ru", "ta",
  "te", "th", "tr", "uk", "vi",
]); // prettier-ignore

function language(locale: string): string {
  return locale.split("-")[0]?.toLowerCase() ?? locale;
}

/** "Pace: …" direction for the style prompt (Gemini TTS has no rate parameter). */
export function paceDirection(pace: number): string {
  const label =
    pace < 0.85
      ? "slow and unhurried"
      : pace < 0.95
        ? "relaxed"
        : pace <= 1.05
          ? "natural"
          : pace <= 1.2
            ? "brisk"
            : "fast and punchy";
  return `Pace: ${label} (about ${pace.toFixed(2)}x a normal speaking rate).`;
}

export function geminiTtsStyle(persona: VoicePersona, req: Pick<VoiceRequest, "style" | "pace">): string {
  const parts = [promptSafe(persona.style, 200), promptSafe(req.style, 200), paceDirection(req.pace)]
    .map((p) => p.replace(/[.\s]+$/, ""))
    .filter(Boolean);
  return `${[...new Set(parts)].join(". ")}.`;
}

interface VoiceMeta {
  durationMs: number;
  voice: string;
  characters: number;
  words?: WordTime[];
}

function voiceResult(dir: string, meta: VoiceMeta, cached: boolean): VoiceResult {
  return {
    path: path.join(dir, "voice.wav"),
    durationMs: meta.durationMs,
    ...(meta.words ? { words: meta.words } : {}),
    voice: meta.voice,
    characters: meta.characters,
    cached,
  };
}

/* ================================================================== Gemini TTS ==================== */

export class GoogleGeminiTtsVoiceProvider implements VoiceProvider {
  readonly name = "gemini-tts";
  readonly capability = "voice" as const;
  readonly local = false;
  readonly model: string;
  private readonly defaultVoice: string;

  constructor(
    env: Pick<Env, "GOOGLE_TTS_MODEL" | "GOOGLE_TTS_VOICE">,
    private readonly ai: GoogleAI,
  ) {
    this.model = env.GOOGLE_TTS_MODEL;
    this.defaultVoice = env.GOOGLE_TTS_VOICE;
  }

  available(): Promise<{ ok: boolean; reason?: string }> {
    return Promise.resolve(
      this.ai.hasApiKey ? { ok: true } : { ok: false, reason: "GOOGLE_API_KEY is not configured" },
    );
  }

  supportsLocale(locale: LocaleTag): boolean {
    return GEMINI_TTS_LANGUAGES.has(language(locale));
  }

  /** persona.voices.google[locale] ?? persona.voices.google["*"] ?? GOOGLE_TTS_VOICE */
  voiceFor(req: Pick<VoiceRequest, "locale" | "persona">): string {
    const byLocale = req.persona.voices.google;
    const voice = byLocale?.[req.locale] ?? byLocale?.["*"] ?? this.defaultVoice;
    if (!VOICE_NAME.test(voice))
      throw new FatalError(`invalid Gemini TTS voice name: ${JSON.stringify(voice)}`);
    return voice;
  }

  estimateMicros(req: VoiceRequest): number {
    return this.ai.estimateSpeechMicros(this.model, req.text.length);
  }

  async speak(req: VoiceRequest, ctx: CallContext): Promise<VoiceResult> {
    if (!req.text.trim()) throw new FatalError("voice: empty text");
    const voice = this.voiceFor(req);
    const style = geminiTtsStyle(req.persona, req);
    const key = cacheKey(NS_GEMINI, GEMINI_TTS_VERSION, {
      model: this.model,
      voice,
      style,
      text: req.text,
      locale: req.locale,
    });
    const res = await cachedCall<VoiceMeta>({
      ctx,
      namespace: NS_GEMINI,
      key,
      required: ["voice.wav"],
      capability: "voice",
      model: this.model,
      hitUnits: { characters: req.text.length },
      produce: async (dir) => {
        const speech = await paid(ctx, "voice", this.model, () =>
          this.ai.synthesizeSpeech({
            model: this.model,
            text: req.text,
            voice,
            style,
            languageCode: req.locale,
            label: "reel.voice",
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
        );
        recordCall(ctx, {
          capability: "voice",
          model: this.model,
          costMicros: speech.costMicros,
          estimated: speech.costEstimated,
          usage: speech.usage,
          units: { characters: req.text.length },
          latencyMs: speech.latencyMs,
        });
        const raw = path.join(dir, "gemini.wav");
        await fsp.writeFile(raw, speech.wav);
        const out = path.join(dir, "voice.wav");
        await toWav48k(raw, out, 1, ctx.signal);
        const durationMs = parseWav(await fsp.readFile(out))?.durationMs ?? 0;
        return { durationMs, voice, characters: req.text.length };
      },
    });
    return voiceResult(res.dir, res.meta, res.cached);
  }
}

/* ================================================================== Cloud TTS + marks ============= */

/**
 * Default Cloud TTS voices per locale (WaveNet / Neural2 — families that honour SSML <mark>). Names follow
 * Google's published voice list; verify with `voices.list?languageCode=…` for your project and override per
 * brand with persona.voices.cloudtts[locale] or the provider's `voices` option.
 */
export const DEFAULT_CLOUD_TTS_VOICES: Readonly<Record<string, { female: string; male: string }>> = {
  "pl-PL": { female: "pl-PL-Wavenet-A", male: "pl-PL-Wavenet-B" },
  "en-US": { female: "en-US-Neural2-F", male: "en-US-Neural2-D" },
  "en-GB": { female: "en-GB-Neural2-A", male: "en-GB-Neural2-B" },
  "de-DE": { female: "de-DE-Neural2-C", male: "de-DE-Neural2-D" },
  "fr-FR": { female: "fr-FR-Neural2-C", male: "fr-FR-Neural2-D" },
  "es-ES": { female: "es-ES-Neural2-A", male: "es-ES-Neural2-B" },
  "it-IT": { female: "it-IT-Neural2-A", male: "it-IT-Neural2-C" },
};

/** "pl-PL-Wavenet-A" → "pl-PL" (Cloud TTS wants the voice's own language code) */
export function cloudVoiceLocale(voiceName: string): string | undefined {
  return /^([a-z]{2,3}-[A-Z]{2,3})-/.exec(voiceName)?.[1];
}

export class GoogleCloudTtsMarksVoiceProvider implements VoiceProvider {
  readonly name = "cloud-tts-marks";
  readonly capability = "voice" as const;
  readonly local = false;
  /** the voice name is chosen per locale; costs are recorded per voice family */
  readonly model = "cloudtts-v1beta1";
  private readonly voices: Readonly<Record<string, string | { female: string; male: string }>>;

  constructor(
    private readonly ai: GoogleAI,
    /** locale → voice name (or {female, male}) — merged over DEFAULT_CLOUD_TTS_VOICES */
    opts: { voices?: Record<string, string | { female: string; male: string }> } = {},
  ) {
    this.voices = { ...DEFAULT_CLOUD_TTS_VOICES, ...opts.voices };
  }

  available(): Promise<{ ok: boolean; reason?: string }> {
    return Promise.resolve(
      this.ai.hasCloudToken
        ? { ok: true }
        : { ok: false, reason: "GOOGLE_CLOUD_ACCESS_TOKEN is not configured" },
    );
  }

  supportsLocale(locale: LocaleTag): boolean {
    return this.defaultVoice(locale, "neutral") !== undefined;
  }

  private defaultVoice(locale: string, gender: VoicePersona["gender"]): string | undefined {
    const entry =
      this.voices[locale] ?? Object.entries(this.voices).find(([l]) => language(l) === language(locale))?.[1];
    if (!entry) return undefined;
    return typeof entry === "string" ? entry : gender === "male" ? entry.male : entry.female;
  }

  /** persona.voices.cloudtts[locale] ?? configured / default voice for the locale (or its language) */
  voiceFor(req: Pick<VoiceRequest, "locale" | "persona">): string {
    const voice =
      req.persona.voices.cloudtts?.[req.locale] ?? this.defaultVoice(req.locale, req.persona.gender);
    if (!voice) throw new FatalError(`cloud-tts: no voice configured for ${req.locale}`);
    if (!VOICE_NAME.test(voice))
      throw new FatalError(`invalid Cloud TTS voice name: ${JSON.stringify(voice)}`);
    return voice;
  }

  estimateMicros(req: VoiceRequest): number {
    // must not throw (the chain estimates before it runs): an unresolvable voice is priced at the most
    // expensive per-character family; the call itself then fails and the chain falls back
    let voice = "xx-XX-Studio-A";
    try {
      voice = this.voiceFor(req);
    } catch {
      /* priced pessimistically */
    }
    // billed characters = SSML without <mark> tags ≈ text + <speak></speak>
    return this.ai.estimateSpeechMicros(voice, req.text.length + 15);
  }

  async speak(req: VoiceRequest, ctx: CallContext): Promise<VoiceResult> {
    const words = req.text.split(/\s+/).filter(Boolean);
    if (!words.length) throw new FatalError("voice: empty text");
    const voice = this.voiceFor(req);
    const languageCode = cloudVoiceLocale(voice) ?? req.locale;
    const speakingRate = Math.round(req.pace * 100) / 100;
    const key = cacheKey(NS_CLOUD, CLOUD_TTS_VERSION, { voice, languageCode, words, speakingRate });
    const res = await cachedCall<VoiceMeta>({
      ctx,
      namespace: NS_CLOUD,
      key,
      required: ["voice.wav"],
      capability: "voice",
      model: voice,
      hitUnits: { characters: req.text.length },
      produce: async (dir) => {
        const speech = await paid(ctx, "voice", voice, () =>
          this.ai.synthesizeWithMarks({
            voiceName: voice,
            languageCode,
            words,
            speakingRate,
            sampleRateHertz: 48_000,
            label: "reel.voice",
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
        );
        recordCall(ctx, {
          capability: "voice",
          model: voice,
          costMicros: speech.costMicros,
          estimated: speech.costEstimated,
          units: { characters: speech.characters ?? req.text.length },
          latencyMs: speech.latencyMs,
        });
        const out = path.join(dir, "voice.wav");
        const info = parseWav(speech.audio);
        if (info?.sampleRate === 48_000 && info.channels === 1) {
          await fsp.writeFile(out, speech.audio);
        } else {
          const raw = path.join(dir, "cloudtts.wav");
          await fsp.writeFile(raw, speech.audio);
          await toWav48k(raw, out, 1, ctx.signal);
        }
        const durationMs = parseWav(await fsp.readFile(out))?.durationMs ?? speech.durationMs ?? 0;
        return { durationMs, voice, characters: req.text.length, words: speech.words };
      },
    });
    return voiceResult(res.dir, res.meta, res.cached);
  }
}
