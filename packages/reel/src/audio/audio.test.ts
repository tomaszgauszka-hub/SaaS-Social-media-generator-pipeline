import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256Hex } from "@cre/shared";
import { describe, expect, it } from "vitest";
import type { CallContext } from "../capabilities/types.ts";
import { SFX_KINDS } from "../contracts/ids.ts";
import { MusicIntent } from "../contracts/plan.ts";
import { CostTracker } from "../cost/tracker.ts";
import { resolveReelTools } from "../util/tools.ts";
import { bandProfile, correlation, mixdown, peakAbs, rmsOf, toDb } from "./analysis.ts";
import { renderMusic } from "./music/render.ts";
import { decodeAudio } from "./pcm.ts";
import { LocalSfxProvider } from "./sfx/providers.ts";
import { alignWords, estimateWords } from "./voice/align.ts";
import { PiperVoiceProvider } from "./voice/piper.ts";

const ctx = (): CallContext => ({
  workDir: fs.mkdtempSync(path.join(os.tmpdir(), "reel-audio-")),
  cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "reel-audio-cache-")),
  scope: "test",
  tracker: new CostTracker(),
});

const intent = (over: Partial<MusicIntent> = {}): MusicIntent =>
  MusicIntent.parse({
    genre: "deep_house",
    mood: "warm",
    bpm: 105,
    energy: 0.6,
    durationMs: 12_000,
    events: [
      { timeMs: 0, energy: 0.3 },
      { timeMs: 2300, event: "drop" },
      { timeMs: 7400, event: "riser" },
      { timeMs: 9700, energy: 0.85 },
      { timeMs: 9700, event: "final_hit" },
    ],
    seed: "lamp",
    ...over,
  });

describe("local music", () => {
  it("is deterministic, exactly as long as the intent, peak-safe, and follows the energy curve", () => {
    const a = renderMusic(intent());
    const b = renderMusic(intent());
    const hash = (r: ReturnType<typeof renderMusic>) =>
      sha256Hex(Buffer.from(r.audio.l.buffer).toString("base64"));
    expect(hash(a)).toBe(hash(b));
    expect(a.audio.l.length).toBe(48_000 * 12);
    const mono = mixdown([a.audio.l, a.audio.r]);
    expect(toDb(peakAbs(mono))).toBeLessThanOrEqual(-0.9);
    // the quiet intro (energy 0.3) is quieter than the CTA section (energy 0.85)
    const intro = toDb(rmsOf(mono, 0, 48_000 * 2));
    const cta = toDb(rmsOf(mono, 48_000 * 9.8, 48_000 * 11.5));
    expect(cta - intro).toBeGreaterThan(2);
    expect(Number.isFinite(intro)).toBe(true);
  });

  it("sounds different per genre and mood (spectral profile)", () => {
    const p = (i: MusicIntent) => bandProfile(mixdown([renderMusic(i).audio.l, renderMusic(i).audio.r]));
    const house = p(intent({ durationMs: 4000, events: [] }));
    const ambient = p(intent({ durationMs: 4000, events: [], genre: "ambient", mood: "calm" }));
    expect(correlation(house, ambient)).toBeLessThan(0.98);
  });
});

describe("local SFX", () => {
  it("synthesises every kind, non-silent, peak-safe and distinct", async () => {
    const c = ctx();
    const sfx = new LocalSfxProvider();
    const profiles: number[][] = [];
    for (const kind of SFX_KINDS) {
      const { path: file } = await sfx.get({ kind, seed: "s" }, c);
      // decode both channels: FFmpeg's stereo → mono downmix adds +3 dB for centred sounds
      const [l, r] = await decodeAudio(file, { channels: 2 });
      expect(l!.length, kind).toBeGreaterThan(2_000);
      expect(toDb(Math.max(peakAbs(l!), peakAbs(r!))), kind).toBeLessThanOrEqual(-2.9);
      expect(toDb(rmsOf(l!)), kind).toBeGreaterThan(-45);
      const mono = mixdown([l!, r!]);
      // fingerprint = spectral band shares + loudness envelope (10 windows) + length
      const env = Array.from({ length: 10 }, (_, k) =>
        rmsOf(mono, Math.floor((k * mono.length) / 10), Math.floor(((k + 1) * mono.length) / 10)),
      );
      const maxEnv = Math.max(...env) || 1;
      profiles.push([...bandProfile(mono), ...env.map((e) => e / maxEnv), mono.length / 48_000]);
    }
    // no two kinds are spectrally identical
    for (let i = 0; i < profiles.length; i++)
      for (let j = i + 1; j < profiles.length; j++)
        expect(correlation(profiles[i]!, profiles[j]!), `${SFX_KINDS[i]} vs ${SFX_KINDS[j]}`).toBeLessThan(
          0.999,
        );
    // cached on the second request
    expect((await sfx.get({ kind: "whoosh", seed: "s" }, c)).cached).toBe(true);
  }, 120_000);
});

describe("word timing", () => {
  it("estimates monotonic word times inside the duration", () => {
    const w = estimateWords("Orzechowa podstawa, mosiężny trzon i abażur z tkaniny.", 3000, "pl-PL", 500);
    expect(w).toHaveLength(8);
    expect(w[0]!.startMs).toBeGreaterThanOrEqual(500);
    expect(w[w.length - 1]!.endMs).toBeLessThanOrEqual(3500);
    for (let i = 1; i < w.length; i++) expect(w[i]!.startMs).toBeGreaterThanOrEqual(w[i - 1]!.endMs - 1);
  });

  const tools = resolveReelTools();
  const hasPiper = Boolean(tools.piperBin && fs.existsSync(tools.piperBin));
  it.skipIf(!hasPiper)(
    "Piper speaks Polish and German and local alignment keeps words inside the speech",
    async () => {
      const c = ctx();
      const piper = new PiperVoiceProvider();
      for (const [locale, text] of [
        ["pl-PL", "Orzechowa podstawa, mosiężny trzon i abażur z tkaniny."],
        ["de-DE", "Sockel aus Walnuss, Stange aus Messing, Schirm aus Stoff."],
      ] as const) {
        expect(piper.supportsLocale(locale)).toBe(true);
        const r = await piper.speak(
          {
            text,
            locale,
            persona: { id: "p", description: "d", style: "warm", pace: 1, gender: "female", voices: {} },
            pace: 1,
            style: "warm",
          },
          c,
        );
        expect(r.durationMs).toBeGreaterThan(1500);
        const al = await alignWords(r.path, text, locale);
        expect(al.words.length).toBe(text.split(/\s+/).length);
        for (let i = 1; i < al.words.length; i++)
          expect(al.words[i]!.startMs).toBeGreaterThanOrEqual(al.words[i - 1]!.startMs);
        expect(al.words[al.words.length - 1]!.endMs).toBeLessThanOrEqual(r.durationMs + 50);
      }
    },
    120_000,
  );
});
