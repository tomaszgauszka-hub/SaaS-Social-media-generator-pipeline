import fsp from "node:fs/promises";
import path from "node:path";
import type { Env } from "@cre/config";
import { extensionForMime, parseWav, type GoogleAI } from "@cre/providers";
import type { CallContext, MusicProvider } from "../../capabilities/types.ts";
import type { MusicGenre, MusicMood } from "../../contracts/ids.ts";
import type { MusicEvent, MusicIntent } from "../../contracts/plan.ts";
import { cacheKey } from "../../util/cache.ts";
import { cachedCall, paid, promptSafe, recordCall, toWav48k } from "./common.ts";

/*
 * Lyria music: the MusicIntent (genre, mood, BPM, energy, timed events) becomes a deterministic prompt with
 * timestamped sections and "Instrumental only, no vocals." Lyria has no duration / seed / negative-prompt
 * parameter, so length and structure are requested in text; the audio module fits the result to the timeline
 * (bar-aligned cut, fade, final hit). Output MP3 is decoded to 48 kHz stereo WAV. Every Lyria output carries a
 * SynthID watermark and a C2PA manifest (kept in the cached source MP3).
 */

export const LYRIA_PROMPT_VERSION = "lyria-prompt/1";
const NS = "google.lyria";
export const LYRIA_LICENSE = "Google Lyria (SynthID) — check commercial terms";

const GENRE_TEXT: Record<MusicGenre, string> = {
  industrial_electronic:
    "industrial electronic — metallic percussion, analog synth bass, tight mechanical groove",
  lofi_house: "lo-fi house — warm detuned chords, soft swung drums, dusty texture",
  cinematic: "cinematic hybrid — orchestral pulses, low strings, big tight drums",
  minimal_tech: "minimal tech — clean plucks, tight kick, sparse modern sound design",
  acoustic_pop: "acoustic pop — bright acoustic guitar, claps, light percussion",
  deep_house: "deep house — four-on-the-floor kick, warm round bass, airy pads",
  ambient: "ambient — evolving pads, soft textures, gentle pulse",
  funk: "funk — slap bass, clean rhythm guitar, short brass stabs",
};

const MOOD_TEXT: Record<MusicMood, string> = {
  confident: "confident and assured",
  warm: "warm and inviting",
  uplifting: "uplifting and optimistic",
  calm: "calm and relaxed",
  energetic: "energetic and driving",
  dark: "dark and moody",
  playful: "playful and light",
  elegant: "elegant and refined",
};

const EVENT_TEXT: Record<NonNullable<MusicEvent["event"]>, string> = {
  riser: "Riser — build tension towards the next section",
  drop: "Drop — full groove, all elements in",
  final_hit: "Final hit — one strong accent, then let the last chord ring out",
  stop: "Stop — the music stops cleanly",
};

function energyWord(e: number): string {
  if (e < 0.25) return "very low";
  if (e < 0.45) return "low";
  if (e < 0.65) return "medium";
  if (e < 0.85) return "high";
  return "very high";
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface Section {
  from: number;
  to: number;
  text: string;
}

/** Timestamped sections from the intent's events (whole seconds; events closer than 1 s merge). */
export function musicSections(intent: MusicIntent): Section[] {
  const total = Math.max(1, Math.round(intent.durationMs / 1000));
  const events = [...intent.events]
    .filter((e) => e.timeMs > 0 && e.timeMs < intent.durationMs)
    .sort((a, b) => a.timeMs - b.timeMs);
  if (!events.length) {
    // no plan events: intro → main groove → ending with a clean final accent
    const a = Math.max(1, Math.round(total * 0.25));
    const b = Math.max(a + 1, Math.round(total * 0.85));
    const raw = [
      { from: 0, to: a, text: `Intro, energy ${energyWord(intent.energy * 0.6)}` },
      { from: a, to: b, text: `Main groove, energy ${energyWord(intent.energy)}` },
      { from: b, to: total, text: "Ending — final accent, then ring out" },
    ];
    return raw.filter((s) => s.to > s.from);
  }
  const sections: Section[] = [];
  let energy = intent.energy * 0.6;
  let from = 0;
  let text = `Intro, energy ${energyWord(energy)}`;
  for (const e of events) {
    const at = Math.round(e.timeMs / 1000);
    energy = e.energy ?? energy;
    const label = e.event ? EVENT_TEXT[e.event] : "Energy shift";
    const next = `${label}, energy ${energyWord(energy)}`;
    if (at <= from) {
      // merges with the current section (sub-second spacing)
      text = `${text}; ${next}`;
      continue;
    }
    sections.push({ from, to: at, text });
    from = at;
    text = next;
  }
  if (total > from) sections.push({ from, to: total, text });
  else if (sections.length) sections[sections.length - 1]!.text += `; ${text}`;
  else sections.push({ from: 0, to: total, text });
  return sections;
}

/** The full Lyria prompt — a pure function of the intent (same intent → same prompt → cache hit). */
export function buildLyriaPrompt(intent: MusicIntent): string {
  const total = Math.max(1, Math.round(intent.durationMs / 1000));
  const feel = promptSafe(intent.brandFeel, 120);
  return [
    `Genre: ${GENRE_TEXT[intent.genre]}.`,
    `Mood: ${MOOD_TEXT[intent.mood]}.`,
    `Tempo: ${intent.bpm} BPM, 4/4, steady tempo throughout.`,
    `Overall energy: ${energyWord(intent.energy)} (${intent.energy.toFixed(2)} on a 0-1 scale).`,
    ...(feel ? [`Brand feel: ${feel}.`] : []),
    `Use: background music under a voice-over in a ${total}-second vertical product advert — no busy lead melody in the vocal range.`,
    `Length: exactly ${total} seconds (${clock(total)}).`,
    "Structure:",
    ...musicSections(intent).map((s) => `[${clock(s.from)} - ${clock(s.to)}] ${s.text}`),
    "Instrumental only, no vocals.",
  ].join("\n");
}

interface LyriaSong {
  /** file name of the original Lyria output (MP3 with SynthID + C2PA) inside the cache entry */
  source: string;
  /** lyrics / structure text Lyria returned next to the audio */
  text?: string;
}

interface LyriaMeta extends LyriaSong {
  durationMs: number;
  bpm: number;
  model: string;
}

async function readSong(dir: string): Promise<LyriaSong | undefined> {
  try {
    const song = JSON.parse(await fsp.readFile(path.join(dir, "song.json"), "utf8")) as LyriaSong;
    // only a plain file name inside this cache entry
    if (!/^source\.[a-z0-9]{2,5}$/.test(song.source)) return undefined;
    await fsp.access(path.join(dir, song.source));
    return song;
  } catch {
    return undefined;
  }
}

export class GoogleLyriaMusicProvider implements MusicProvider {
  readonly name = "lyria";
  readonly capability = "music" as const;
  readonly local = false;
  readonly model: string;
  readonly commercialUse: boolean;

  constructor(
    env: Pick<Env, "GOOGLE_MUSIC_MODEL" | "GOOGLE_MUSIC_COMMERCIAL_USE">,
    private readonly ai: GoogleAI,
    /** the caller declares the reel is not for commercial use (Lyria allowed without the licence flag) */
    private readonly opts: { nonCommercialUse?: boolean } = {},
  ) {
    this.model = env.GOOGLE_MUSIC_MODEL;
    this.commercialUse = env.GOOGLE_MUSIC_COMMERCIAL_USE;
  }

  available(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.ai.hasApiKey) return Promise.resolve({ ok: false, reason: "GOOGLE_API_KEY is not configured" });
    if (!this.commercialUse && !this.opts.nonCommercialUse) {
      return Promise.resolve({
        ok: false,
        reason: "GOOGLE_MUSIC_COMMERCIAL_USE=false (Lyria commercial licence not confirmed)",
      });
    }
    return Promise.resolve({ ok: true });
  }

  estimateMicros(_intent: MusicIntent): number {
    return this.ai.estimateMusicMicros(this.model);
  }

  async compose(
    intent: MusicIntent,
    ctx: CallContext,
  ): Promise<{ path: string; durationMs: number; bpm: number; license: string; cached: boolean }> {
    const prompt = buildLyriaPrompt(intent);
    // the plan seed separates A/B arms (Lyria itself has no seed)
    const key = cacheKey(NS, LYRIA_PROMPT_VERSION, { model: this.model, prompt, seed: intent.seed });
    const res = await cachedCall<LyriaMeta>({
      ctx,
      namespace: NS,
      key,
      required: ["music.wav"],
      capability: "music",
      model: this.model,
      produce: async (dir) => {
        // a song paid for by an earlier attempt that failed while decoding is reused, not bought again
        let song = await readSong(dir);
        if (!song) {
          const res = await paid(ctx, "music", this.model, () =>
            this.ai.generateMusic({
              model: this.model,
              prompt,
              label: "reel.music",
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            }),
          );
          recordCall(ctx, {
            capability: "music",
            model: this.model,
            costMicros: res.costMicros,
            estimated: res.costEstimated,
            usage: res.usage,
            units: { songs: 1 },
            latencyMs: res.latencyMs,
          });
          song = {
            source: `source${extensionForMime(res.mimeType)}`,
            ...(res.text ? { text: res.text.slice(0, 4000) } : {}),
          };
          await fsp.writeFile(path.join(dir, song.source), res.bytes);
          await fsp.writeFile(path.join(dir, "song.json"), JSON.stringify(song));
        }
        const wav = path.join(dir, "music.wav");
        await toWav48k(path.join(dir, song.source), wav, 2, ctx.signal);
        const durationMs = parseWav(await fsp.readFile(wav))?.durationMs ?? 0;
        return { durationMs, bpm: intent.bpm, model: this.model, ...song };
      },
    });
    return {
      path: path.join(res.dir, "music.wav"),
      durationMs: res.meta.durationMs,
      bpm: res.meta.bpm,
      license: LYRIA_LICENSE,
      cached: res.cached,
    };
  }
}
