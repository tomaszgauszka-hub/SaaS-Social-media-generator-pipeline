import fsp from "node:fs/promises";
import { generateSpeech, getFfmpegConfig } from "@cre/media";
import { parseWav } from "@cre/providers";
import { FatalError } from "@cre/shared";
import type { CallContext, VoiceProvider, VoiceRequest, VoiceResult } from "../../capabilities/types.ts";
import type { LocaleTag } from "../../contracts/ids.ts";
import { cacheKey, FileCache } from "../../util/cache.ts";
import { runProcess } from "../../util/proc.ts";
import { processVoice, VOICE_CHAIN_VERSION } from "./process.ts";
import { language, speechText } from "./text.ts";

/**
 * Flite through FFmpeg's `flite` source (English only, robotic) — the last resort of the voice chain when no
 * neural voice can run. Reuses @cre/media generateSpeech (text file, no shell); pace via atempo, then the same
 * voice processing as Piper.
 */

export const FLITE_PROVIDER = "flite";
export const FLITE_VERSION = "flite-ffmpeg/1";
const NS = "voice.flite";

let fliteCheck: Promise<boolean> | undefined;

/** does the configured FFmpeg have the flite filter (checked once per process) */
export function ffmpegHasFlite(): Promise<boolean> {
  fliteCheck ??= runProcess(getFfmpegConfig().ffmpegPath, ["-hide_banner", "-h", "filter=flite"], {
    check: false,
    timeoutMs: 15_000,
  })
    .then((r) => r.code === 0 && /flite/i.test(r.stdout) && !/Unknown filter/i.test(r.stdout + r.stderr))
    .catch(() => false);
  return fliteCheck;
}

export class FliteVoiceProvider implements VoiceProvider {
  readonly name = FLITE_PROVIDER;
  readonly capability = "voice" as const;
  readonly local = true;
  readonly model = FLITE_VERSION;

  async available(): Promise<{ ok: boolean; reason?: string }> {
    return (await ffmpegHasFlite()) ? { ok: true } : { ok: false, reason: "FFmpeg has no flite filter" };
  }

  supportsLocale(locale: LocaleTag): boolean {
    return language(locale) === "en";
  }

  estimateMicros(_req: VoiceRequest): number {
    return 0;
  }

  async speak(req: VoiceRequest, ctx: CallContext): Promise<VoiceResult> {
    if (!this.supportsLocale(req.locale)) throw new FatalError(`flite: ${req.locale} is not supported`);
    const text = speechText(req.text);
    if (!text) throw new FatalError("flite: empty text");
    const voice = req.persona.gender === "male" ? "kal" : "slt";
    const tempo = Math.min(1.4, Math.max(0.7, req.pace));
    const key = cacheKey(NS, FLITE_VERSION, { voice, text, tempo, chain: VOICE_CHAIN_VERSION });
    const started = Date.now();
    const res = await new FileCache(ctx.cacheDir).getOrCreate(NS, key, "voice.wav", async (tmp) => {
      const raw = `${tmp}.flite.wav`;
      try {
        await generateSpeech(raw, { text, voice, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        await processVoice(raw, tmp, { tempo, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      } finally {
        await fsp.rm(raw, { force: true });
      }
    });
    const durationMs = parseWav(await fsp.readFile(res.path))?.durationMs ?? 0;
    ctx.tracker.compute({
      stage: "tts_local",
      label: `flite ${voice} ${text.length} chars`,
      wallMs: Date.now() - started,
      cached: res.hit,
      scope: ctx.scope,
    });
    return { path: res.path, durationMs, voice: `flite:${voice}`, characters: text.length, cached: res.hit };
  }
}
