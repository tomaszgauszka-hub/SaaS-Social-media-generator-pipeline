import fsp from "node:fs/promises";
import path from "node:path";
import { resolveModelCatalog, resolveProviderSelection, ttsCostMicros, type Env } from "@cre/config";
import { ElevenLabsTTSProvider, parseWav } from "@cre/providers";
import { FatalError } from "@cre/shared";
import type { CallContext, VoiceProvider, VoiceRequest, VoiceResult } from "../../capabilities/types.ts";
import type { LocaleTag } from "../../contracts/ids.ts";
import type { WordTime } from "../../contracts/media.ts";
import { cacheKey, FileCache } from "../../util/cache.ts";
import { processVoice } from "./process.ts";
import { language, speechText } from "./text.ts";

/**
 * ElevenLabs voice for the reel, wrapping the existing @cre/providers ElevenLabsTTSProvider (character-level
 * timestamps → exact word timings). Model id from configuration; voice per persona / locale or
 * ELEVENLABS_VOICE_ID. The clip is resampled to 48 kHz mono without trimming (the word timings stay valid);
 * a pace other than 1 is applied with atempo and the word timings are scaled with it. Cached by
 * (model, voice, text, pace); every paid call is recorded with its pre-call estimate.
 */

export const ELEVENLABS_VOICE_PROVIDER = "elevenlabs";
export const ELEVENLABS_VOICE_VERSION = "elevenlabs-voice/1";
const NS = "voice.elevenlabs";

/** languages of the multilingual Flash / Turbo v2.5 models */
export const ELEVENLABS_LANGUAGES: ReadonlySet<string> = new Set([
  "ar", "bg", "cs", "da", "de", "el", "en", "es", "fi", "fil", "fr", "hi", "hr", "hu", "id", "it", "ja", "ko",
  "ms", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sv", "ta", "tr", "uk", "vi", "zh",
]); // prettier-ignore

const VOICE_ID = /^[A-Za-z0-9]{8,40}$/;

interface Meta {
  durationMs: number;
  voice: string;
  characters: number;
  words?: WordTime[];
}

/** the TTS call this provider wraps (injectable for tests) */
export type ElevenLabsTts = Pick<ElevenLabsTTSProvider, "execute">;

export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly name = ELEVENLABS_VOICE_PROVIDER;
  readonly capability = "voice" as const;
  readonly local = false;
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly defaultVoice: string | undefined;

  constructor(
    env: Env,
    private readonly opts: { model?: string; tts?: (voiceId: string) => ElevenLabsTts } = {},
  ) {
    this.apiKey = env.ELEVENLABS_API_KEY || undefined;
    this.defaultVoice = env.ELEVENLABS_VOICE_ID || undefined;
    this.model =
      opts.model ?? resolveModelCatalog(env, { ...resolveProviderSelection(env), tts: "elevenlabs" }).tts;
  }

  available(): Promise<{ ok: boolean; reason?: string }> {
    return Promise.resolve(
      this.apiKey ? { ok: true } : { ok: false, reason: "ELEVENLABS_API_KEY is not configured" },
    );
  }

  supportsLocale(locale: LocaleTag): boolean {
    return ELEVENLABS_LANGUAGES.has(language(locale));
  }

  /** persona.voices.elevenlabs[locale | language | "*"] ?? ELEVENLABS_VOICE_ID */
  voiceFor(req: Pick<VoiceRequest, "locale" | "persona">): string {
    const v = req.persona.voices.elevenlabs;
    const id = v?.[req.locale] ?? v?.[language(req.locale)] ?? v?.["*"] ?? this.defaultVoice;
    if (!id)
      throw new FatalError("elevenlabs: no voice id (persona.voices.elevenlabs or ELEVENLABS_VOICE_ID)");
    if (!VOICE_ID.test(id)) throw new FatalError(`elevenlabs: invalid voice id ${JSON.stringify(id)}`);
    return id;
  }

  estimateMicros(req: VoiceRequest): number {
    return ttsCostMicros("elevenlabs", this.model, { characters: speechText(req.text).length });
  }

  async speak(req: VoiceRequest, ctx: CallContext): Promise<VoiceResult> {
    if (!this.apiKey) throw new FatalError("ELEVENLABS_API_KEY is not configured");
    const voice = this.voiceFor(req);
    const text = speechText(req.text);
    if (!text) throw new FatalError("elevenlabs: empty text");
    const tempo = Math.min(1.4, Math.max(0.7, req.pace));
    const cache = new FileCache(ctx.cacheDir);
    const key = cacheKey(NS, ELEVENLABS_VOICE_VERSION, { model: this.model, voice, text, tempo });
    let meta = await cache.readJson<Meta>(NS, key, "meta.json");
    const cached = Boolean(meta && cache.has(NS, key, "voice.wav"));
    if (cached) {
      ctx.tracker.record({
        capability: "voice",
        provider: this.name,
        model: this.model,
        costMicros: 0,
        estimated: false,
        cached: true,
        units: { characters: text.length },
        scope: ctx.scope,
      });
    } else {
      const res = await cache.getOrCreate(NS, key, "voice.wav", async (tmp) => {
        const started = Date.now();
        const tts =
          this.opts.tts?.(voice) ??
          new ElevenLabsTTSProvider({ apiKey: this.apiKey, voiceId: voice, model: this.model });
        const out = await tts.execute(
          { text, voice, language: language(req.locale) },
          { workDir: path.dirname(tmp), ...(ctx.signal ? { signal: ctx.signal } : {}) },
        );
        ctx.tracker.record({
          capability: "voice",
          provider: this.name,
          model: this.model,
          costMicros: out.actualCostMicros ?? this.estimateMicros(req),
          estimated: out.actualCostMicros === undefined,
          cached: false,
          units: { characters: text.length },
          latencyMs: Date.now() - started,
          scope: ctx.scope,
        });
        try {
          await processVoice(out.filePath, tmp, {
            voiceChain: false,
            trim: false,
            tempo,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
        } finally {
          await fsp.rm(out.filePath, { force: true });
        }
        const words = out.timingsExact
          ? out.words.map((w) => ({
              text: w.text,
              startMs: Math.round(w.startMs / tempo),
              endMs: Math.round(w.endMs / tempo),
            }))
          : undefined;
        meta = { durationMs: 0, voice, characters: text.length, ...(words ? { words } : {}) };
      });
      meta = {
        ...(meta ?? { voice, characters: text.length }),
        durationMs: parseWav(await fsp.readFile(res.path))?.durationMs ?? 0,
      };
      await cache.writeJson(NS, key, meta, "meta.json");
    }
    const m = meta!;
    return {
      path: cache.file(NS, key, "voice.wav"),
      durationMs: m.durationMs,
      ...(m.words ? { words: m.words } : {}),
      voice: m.voice,
      characters: m.characters,
      cached,
    };
  }
}
