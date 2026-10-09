import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseWav } from "@cre/providers";
import { FatalError } from "@cre/shared";
import type { CallContext, VoiceProvider, VoiceRequest, VoiceResult } from "../../capabilities/types.ts";
import type { LocaleTag } from "../../contracts/ids.ts";
import type { VoicePersona } from "../../contracts/profiles.ts";
import { cacheKey, FileCache } from "../../util/cache.ts";
import { runProcess } from "../../util/proc.ts";
import { resolveReelTools } from "../../util/tools.ts";
import { processVoice, VOICE_CHAIN_VERSION } from "./process.ts";
import { language, speechText } from "./text.ts";

/**
 * Piper — local neural TTS (rhasspy/piper, ONNX voices). The text goes in on stdin (never as an argument),
 * the binary runs without a shell from its own directory (it loads espeak-ng / onnxruntime from there), the
 * pace maps to --length_scale, and the clip is resampled to 48 kHz with light voice processing. Voices are
 * model files in PIPER_VOICES_DIR referenced by base name only; the brand persona may pick one per locale or
 * language (persona.voices.piper["pl-PL" | "pl"]), otherwise the defaults below apply.
 */

export const PIPER_PROVIDER = "piper";
export const PIPER_VERSION = "piper-1.2/1";
const NS = "voice.piper";

/** default voice per language (files `<name>.onnx` + `<name>.onnx.json` in the voices directory) */
export const DEFAULT_PIPER_VOICES: Readonly<Record<string, string>> = {
  pl: "pl-mls_6892-low",
  de: "de-thorsten-low",
  en: "en-us-lessac-medium",
  fr: "fr-siwis-medium",
  es: "es-carlfm-x-low",
  it: "it-riccardo_fasol-x-low",
};

const VOICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

/** Piper's phoneme length scale for a pace (1.15 → 0.87: faster) */
export function lengthScale(pace: number): number {
  return Math.round(Math.min(1.5, Math.max(0.6, 1 / Math.max(0.1, pace))) * 1000) / 1000;
}

export class PiperVoiceProvider implements VoiceProvider {
  readonly name = PIPER_PROVIDER;
  readonly capability = "voice" as const;
  readonly local = true;
  readonly model = PIPER_VERSION;
  private readonly bin: string | null;
  private readonly voicesDir: string | null;
  private readonly voices: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(
    opts: {
      bin?: string | null;
      voicesDir?: string | null;
      /** locale or language → voice base name (merged over DEFAULT_PIPER_VOICES) */
      voices?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ) {
    const tools = opts.bin === undefined || opts.voicesDir === undefined ? resolveReelTools() : undefined;
    this.bin = opts.bin === undefined ? (tools?.piperBin ?? null) : opts.bin;
    this.voicesDir = opts.voicesDir === undefined ? (tools?.piperVoicesDir ?? null) : opts.voicesDir;
    this.voices = { ...DEFAULT_PIPER_VOICES, ...opts.voices };
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  available(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.bin || !fs.existsSync(this.bin))
      return Promise.resolve({ ok: false, reason: "piper binary not found (PIPER_BIN)" });
    if (!this.voicesDir || !fs.existsSync(this.voicesDir))
      return Promise.resolve({ ok: false, reason: "piper voices not found (PIPER_VOICES_DIR)" });
    return Promise.resolve({ ok: true });
  }

  private modelPath(name: string): string | null {
    if (!this.voicesDir || !VOICE_NAME.test(name)) return null;
    const p = path.join(this.voicesDir, `${name}.onnx`);
    return fs.existsSync(p) && fs.existsSync(`${p}.json`) ? p : null;
  }

  /** persona (locale → language) → configured (locale → language); only voices that exist on disk */
  voiceFor(locale: LocaleTag, persona?: Pick<VoicePersona, "voices">): string | null {
    const lang = language(locale);
    const fromPersona = persona?.voices.piper;
    for (const name of [fromPersona?.[locale], fromPersona?.[lang], this.voices[locale], this.voices[lang]])
      if (name && this.modelPath(name)) return name;
    return null;
  }

  supportsLocale(locale: LocaleTag): boolean {
    return this.voiceFor(locale) !== null;
  }

  estimateMicros(_req: VoiceRequest): number {
    return 0;
  }

  async speak(req: VoiceRequest, ctx: CallContext): Promise<VoiceResult> {
    const avail = await this.available();
    if (!avail.ok) throw new FatalError(`piper: ${avail.reason}`);
    const voice = this.voiceFor(req.locale, req.persona);
    if (!voice) throw new FatalError(`piper: no voice for ${req.locale}`);
    const model = this.modelPath(voice)!;
    const text = speechText(req.text);
    if (!text) throw new FatalError("piper: empty text");
    const scale = lengthScale(req.pace);
    const key = cacheKey(NS, PIPER_VERSION, {
      voice,
      voiceBytes: fs.statSync(model).size,
      text,
      lengthScale: scale,
      chain: VOICE_CHAIN_VERSION,
    });
    const started = Date.now();
    const bin = this.bin!;
    const res = await new FileCache(ctx.cacheDir).getOrCreate(NS, key, "voice.wav", async (tmp) => {
      const raw = `${tmp}.piper.wav`;
      const dir = path.dirname(bin);
      try {
        await runProcess(
          bin,
          [
            "--model",
            model,
            "--output_file",
            raw,
            "--length_scale",
            String(scale),
            "--sentence_silence",
            "0.15",
            "--quiet",
          ],
          {
            cwd: dir,
            env: {
              ...process.env,
              LD_LIBRARY_PATH: [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
            },
            input: `${text}\n`,
            timeoutMs: this.timeoutMs,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          },
        );
        await processVoice(raw, tmp, { ...(ctx.signal ? { signal: ctx.signal } : {}) });
      } finally {
        await fsp.rm(raw, { force: true });
      }
    });
    const durationMs = parseWav(await fsp.readFile(res.path))?.durationMs ?? 0;
    ctx.tracker.compute({
      stage: "tts_local",
      label: `piper ${voice} ${text.length} chars`,
      wallMs: Date.now() - started,
      cached: res.hit,
      scope: ctx.scope,
    });
    return { path: res.path, durationMs, voice, characters: text.length, cached: res.hit };
  }
}
