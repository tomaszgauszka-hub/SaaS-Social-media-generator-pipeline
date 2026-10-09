import type { CallContext, MusicProvider } from "../../capabilities/types.ts";
import type { MusicIntent } from "../../contracts/plan.ts";
import { cacheKey, FileCache } from "../../util/cache.ts";
import { writeWav16 } from "../pcm.ts";
import { LOCAL_MUSIC_VERSION, renderMusic } from "./render.ts";

/**
 * LocalMusicProvider — the deterministic procedural composer (no API, no samples, commercial use OK). Same
 * intent → same WAV (cached by every field that shapes the audio; `brandFeel` is prompt text only and does not).
 */

export const LOCAL_MUSIC_PROVIDER = "local-synth";
export const LOCAL_MUSIC_LICENSE = "procedural (local synth, royalty-free, commercial use OK)";
const NS = "music.local";

/** the fields of an intent that change the rendered audio */
export function musicIntentKey(intent: MusicIntent): unknown {
  return {
    genre: intent.genre,
    mood: intent.mood,
    bpm: intent.bpm,
    energy: intent.energy,
    durationMs: intent.durationMs,
    events: [...intent.events].sort(
      (a, b) => a.timeMs - b.timeMs || String(a.event).localeCompare(String(b.event)),
    ),
    seed: intent.seed,
  };
}

export class LocalMusicProvider implements MusicProvider {
  readonly name = LOCAL_MUSIC_PROVIDER;
  readonly capability = "music" as const;
  readonly local = true;
  readonly model = LOCAL_MUSIC_VERSION;
  readonly commercialUse = true;

  available(): Promise<{ ok: boolean; reason?: string }> {
    return Promise.resolve({ ok: true });
  }

  estimateMicros(_intent: MusicIntent): number {
    return 0;
  }

  async compose(
    intent: MusicIntent,
    ctx: CallContext,
  ): Promise<{ path: string; durationMs: number; bpm: number; license: string; cached: boolean }> {
    const started = Date.now();
    const key = cacheKey(NS, LOCAL_MUSIC_VERSION, musicIntentKey(intent));
    const res = await new FileCache(ctx.cacheDir).getOrCreate(NS, key, "music.wav", async (tmp) => {
      ctx.signal?.throwIfAborted();
      const r = renderMusic(intent);
      await writeWav16(tmp, [r.audio.l, r.audio.r]);
      ctx.logger?.debug(
        { genre: intent.genre, mood: intent.mood, bpm: intent.bpm, ms: r.renderMs },
        "local music rendered",
      );
    });
    ctx.tracker.compute({
      stage: "audio_synth",
      label: `music ${intent.genre}/${intent.mood} ${intent.bpm} bpm ${intent.durationMs} ms`,
      wallMs: Date.now() - started,
      cached: res.hit,
      scope: ctx.scope,
    });
    return {
      path: res.path,
      durationMs: intent.durationMs,
      bpm: intent.bpm,
      license: LOCAL_MUSIC_LICENSE,
      cached: res.hit,
    };
  }
}
