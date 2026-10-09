import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Env } from "@cre/config";
import { requestBinary } from "@cre/providers";
import { FatalError, sha256Hex } from "@cre/shared";
import type { CallContext, SfxProvider } from "../../capabilities/types.ts";
import { SfxKind } from "../../contracts/ids.ts";
import { cacheKey, FileCache } from "../../util/cache.ts";
import { decodeAudio, writeWav16 } from "../pcm.ts";
import { prng } from "../synth.ts";
import { LOCAL_SFX_VERSION, renderSfx, SFX_PEAK_DB, sfxLengthMs } from "./synth.ts";

/**
 * SFX providers. All of them store results in ONE content-addressed store (<cacheDir>/sfx/…) keyed by the
 * producing provider + model + kind + length (+ seed for local synthesis, whose variants are free), so:
 *  - LocalSfxProvider    — deterministic synthesis of every SfxKind (no API, commercial use OK);
 *  - ElevenLabsSfxProvider — text-to-sound-effects API with a whitelisted description per kind (never free
 *                          text), cost estimated before the call and recorded after it;
 *  - CachedSfxProvider   — a cache in front of any provider: "hits only" (serves what a provider produced
 *                          earlier — an ElevenLabs sound bought once is reused forever, even without a key)
 *                          or read-through.
 */

const NS = "sfx";
export const SFX_STORE_VERSION = "sfx-store/1";
export const LOCAL_SFX_PROVIDER = "local-sfx";
export const ELEVENLABS_SFX_PROVIDER = "elevenlabs-sfx";

export interface SfxRequest {
  kind: SfxKind;
  seed: string;
  durationMs?: number;
}

/** store key of a provider's result (API results ignore the seed: one paid sound serves every reel) */
export function sfxStoreKey(source: Pick<SfxProvider, "name" | "model" | "local">, req: SfxRequest): string {
  const ms = sfxLengthMs(req.kind, req.durationMs);
  return cacheKey(NS, SFX_STORE_VERSION, {
    provider: source.name,
    model: source.model,
    kind: req.kind,
    ms: source.local ? ms : Math.round(ms / 250) * 250,
    ...(source.local ? { seed: req.seed } : {}),
  });
}

function seedOf(text: string): number {
  return parseInt(sha256Hex(text).slice(0, 8), 16);
}

/* ================================================================== local ========================= */

export class LocalSfxProvider implements SfxProvider {
  readonly name = LOCAL_SFX_PROVIDER;
  readonly capability = "sfx" as const;
  readonly local = true;
  readonly model = LOCAL_SFX_VERSION;

  available(): Promise<{ ok: boolean; reason?: string }> {
    return Promise.resolve({ ok: true });
  }

  has(kind: SfxKind): boolean {
    return SfxKind.safeParse(kind).success;
  }

  estimateMicros(_kind: SfxKind): number {
    return 0;
  }

  async get(req: SfxRequest, ctx: CallContext): Promise<{ path: string; cached: boolean }> {
    const kind = SfxKind.parse(req.kind);
    const started = Date.now();
    const res = await new FileCache(ctx.cacheDir).getOrCreate(
      NS,
      sfxStoreKey(this, req),
      "sfx.wav",
      async (tmp) => {
        const s = renderSfx(kind, prng(seedOf(`${req.seed}|${kind}`)), req.durationMs);
        await writeWav16(tmp, [s.audio.l, s.audio.r]);
      },
    );
    ctx.tracker.compute({
      stage: "audio_synth",
      label: `sfx ${kind}`,
      wallMs: Date.now() - started,
      cached: res.hit,
      scope: ctx.scope,
    });
    return { path: res.path, cached: res.hit };
  }
}

/* ================================================================== cache decorator =============== */

export class CachedSfxProvider implements SfxProvider {
  readonly name: string;
  readonly capability = "sfx" as const;
  readonly local: boolean;
  readonly model: string;
  private readonly cache: FileCache;
  private readonly readThrough: boolean;

  constructor(
    private readonly source: SfxProvider,
    opts: { cacheDir: string; readThrough?: boolean },
  ) {
    this.cache = new FileCache(opts.cacheDir);
    this.readThrough = opts.readThrough ?? false;
    this.name = `cache:${source.name}`;
    this.model = source.model;
    // serving a hit never spends; read-through may call the source
    this.local = this.readThrough ? source.local : true;
  }

  private hit(req: SfxRequest): string | undefined {
    const key = sfxStoreKey(this.source, req);
    return this.cache.has(NS, key, "sfx.wav") ? this.cache.file(NS, key, "sfx.wav") : undefined;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    const any = fs.existsSync(path.join(this.cache.root, NS));
    if (!this.readThrough) return any ? { ok: true } : { ok: false, reason: "sfx cache is empty" };
    return any ? { ok: true } : await this.source.available();
  }

  has(kind: SfxKind): boolean {
    return this.source.has(kind);
  }

  estimateMicros(kind: SfxKind): number {
    if (!this.readThrough || this.hit({ kind, seed: "" })) return 0;
    return this.source.estimateMicros(kind);
  }

  async get(req: SfxRequest, ctx: CallContext): Promise<{ path: string; cached: boolean }> {
    const cached = this.hit(req);
    if (cached) {
      if (!this.source.local)
        ctx.tracker.record({
          capability: "sfx",
          provider: this.source.name,
          model: this.source.model,
          costMicros: 0,
          estimated: false,
          cached: true,
          units: { sounds: 1 },
          scope: ctx.scope,
        });
      return { path: cached, cached: true };
    }
    if (!this.readThrough) throw new Error(`${req.kind} not in the ${this.source.name} cache`);
    const avail = await this.source.available();
    if (!avail.ok) throw new Error(`${this.source.name} unavailable: ${avail.reason ?? "unavailable"}`);
    const res = await this.source.get(req, ctx);
    const key = sfxStoreKey(this.source, req);
    const target = this.cache.file(NS, key, "sfx.wav");
    if (path.resolve(res.path) !== path.resolve(target)) {
      await this.cache.getOrCreate(NS, key, "sfx.wav", (tmp) => fsp.copyFile(res.path, tmp));
    }
    return { path: target, cached: res.cached };
  }
}

/* ================================================================== ElevenLabs ==================== */

/** whitelisted descriptions — the API never receives model- or user-written text */
export const ELEVENLABS_SFX_PROMPTS: Record<SfxKind, string> = {
  whoosh: "Fast clean whoosh, air swoosh passing by the camera, no music",
  impact: "Deep cinematic impact hit with a sub boom and a short tail",
  metal_hit: "Single metallic hit, a struck steel plate ringing briefly",
  metal_click: "Small metal latch click, crisp and short",
  mechanical_click: "Mechanical button click, plastic switch pressed and released",
  motor: "Small electric motor spinning up and whirring steadily",
  snap: "Sharp crisp snap, plastic part snapping into place",
  air_release: "Short pneumatic air release hiss",
  electronic_beep: "Two-tone electronic confirmation beep, clean",
  transition: "Smooth transition swoosh with a reverse swell into a soft hit",
  riser: "Tension riser, rising noise sweep building up and ending abruptly",
  bass_hit: "Deep 808 bass hit, sub drop",
  ui_click: "Soft subtle user interface click",
  shimmer: "Bright magical sparkle shimmer, light chimes",
  light_switch: "Wall light switch flicked on, rocker switch click",
};

/**
 * Pre-call estimate: ElevenLabs bills sound effects in credits per generated second; USD per second at a
 * conservative paid-plan credit price. Not in @cre/config pricing yet (contract request) — override with
 * `pricePerSecondUsd`.
 */
export const ELEVENLABS_SFX_USD_PER_SECOND = 0.012;
export const ELEVENLABS_SFX_DEFAULT_MODEL = "eleven_text_to_sound_v2";

export class ElevenLabsSfxProvider implements SfxProvider {
  readonly name = ELEVENLABS_SFX_PROVIDER;
  readonly capability = "sfx" as const;
  readonly local = false;
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly usdPerSecond: number;
  private readonly baseUrl: string;

  constructor(
    env: Pick<Env, "ELEVENLABS_API_KEY">,
    opts: { model?: string; pricePerSecondUsd?: number; baseUrl?: string } = {},
  ) {
    this.apiKey = env.ELEVENLABS_API_KEY || undefined;
    this.model = opts.model ?? ELEVENLABS_SFX_DEFAULT_MODEL;
    this.usdPerSecond = opts.pricePerSecondUsd ?? ELEVENLABS_SFX_USD_PER_SECOND;
    this.baseUrl = opts.baseUrl ?? "https://api.elevenlabs.io";
  }

  available(): Promise<{ ok: boolean; reason?: string }> {
    return Promise.resolve(
      this.apiKey ? { ok: true } : { ok: false, reason: "ELEVENLABS_API_KEY is not configured" },
    );
  }

  has(kind: SfxKind): boolean {
    return SfxKind.safeParse(kind).success;
  }

  private seconds(kind: SfxKind, durationMs?: number): number {
    // the API accepts 0.5 … 30 s; lengths are bucketed to 250 ms (cache key)
    return Math.min(22, Math.max(0.5, Math.round(sfxLengthMs(kind, durationMs) / 250) * 0.25));
  }

  estimateMicros(kind: SfxKind, durationMs?: number): number {
    return Math.round(this.seconds(kind, durationMs) * this.usdPerSecond * 1e6);
  }

  async get(req: SfxRequest, ctx: CallContext): Promise<{ path: string; cached: boolean }> {
    if (!this.apiKey) throw new FatalError("ELEVENLABS_API_KEY is not configured");
    const kind = SfxKind.parse(req.kind);
    const seconds = this.seconds(kind, req.durationMs);
    const cache = new FileCache(ctx.cacheDir);
    const key = sfxStoreKey(this, req);
    if (cache.has(NS, key, "sfx.wav")) {
      ctx.tracker.record({
        capability: "sfx",
        provider: this.name,
        model: this.model,
        costMicros: 0,
        estimated: false,
        cached: true,
        units: { sounds: 1 },
        scope: ctx.scope,
      });
      return { path: cache.file(NS, key, "sfx.wav"), cached: true };
    }
    const res = await cache.getOrCreate(NS, key, "sfx.wav", async (tmp) => {
      const started = Date.now();
      const { data } = await requestBinary(
        this.name,
        `${this.baseUrl}/v1/sound-generation?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: { "xi-api-key": this.apiKey!, "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({
            text: ELEVENLABS_SFX_PROMPTS[kind],
            duration_seconds: seconds,
            prompt_influence: 0.6,
            model_id: this.model,
          }),
        },
        { timeoutMs: 90_000, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      );
      ctx.tracker.record({
        capability: "sfx",
        provider: this.name,
        model: this.model,
        costMicros: this.estimateMicros(kind, req.durationMs),
        estimated: true,
        cached: false,
        units: { seconds, sounds: 1 },
        latencyMs: Date.now() - started,
        scope: ctx.scope,
      });
      const mp3 = `${tmp}.mp3`;
      try {
        await fsp.writeFile(mp3, data);
        await writeWav16(tmp, await normalizeSfx(mp3, ctx.signal));
      } finally {
        await fsp.rm(mp3, { force: true });
      }
    });
    return { path: res.path, cached: res.hit };
  }
}

/** decode to 48 kHz stereo, drop leading silence (cue sync), peak to SFX_PEAK_DB */
export async function normalizeSfx(file: string, signal?: AbortSignal): Promise<Float32Array[]> {
  const ch = await decodeAudio(file, { channels: 2, ...(signal ? { signal } : {}) });
  const n = ch[0]!.length;
  let peak = 0;
  for (const c of ch) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(c[i]!));
  if (peak < 1e-6) throw new Error("silent sound effect");
  const floor = peak * 10 ** (-40 / 20);
  let start = 0;
  while (start < n && Math.abs(ch[0]![start]!) < floor && Math.abs(ch[1]![start]!) < floor) start++;
  start = Math.max(0, start - 48);
  const g = 10 ** (SFX_PEAK_DB / 20) / peak;
  return ch.map((c) => {
    const out = c.slice(start);
    for (let i = 0; i < out.length; i++) out[i] = out[i]! * g;
    return out;
  });
}
