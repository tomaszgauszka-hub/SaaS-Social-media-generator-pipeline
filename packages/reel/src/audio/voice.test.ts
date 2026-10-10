import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Env } from "@cre/config";
import { describe, expect, it } from "vitest";
import type { CallContext, VoiceProvider, VoiceRequest, VoiceResult } from "../capabilities/types.ts";
import type { WordTime } from "../contracts/media.ts";
import type { VoicePersona } from "../contracts/profiles.ts";
import { BudgetGate, CostTracker } from "../cost/tracker.ts";
import { testPlan } from "../testing/fixtures.ts";
import { msToSamples, REEL_SR, writeWav16 } from "./pcm.ts";
import { absorbShortRegions, alignWordsToPcm, detectSpeech } from "./voice/align.ts";
import { ElevenLabsVoiceProvider, type ElevenLabsTts } from "./voice/elevenlabs.ts";
import { buildVoiceTrack } from "./voice/track.ts";

const ctx = (tracker = new CostTracker()): CallContext => ({
  workDir: fs.mkdtempSync(path.join(os.tmpdir(), "reel-voice-")),
  cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "reel-voice-cache-")),
  scope: "test",
  tracker,
});

const persona: VoicePersona = {
  id: "p",
  description: "d",
  style: "warm",
  pace: 1,
  gender: "female",
  voices: {},
};

/** a 220 Hz tone over each [startMs, endMs) span, silence elsewhere */
function tones(spans: readonly [number, number][], totalMs: number): Float32Array {
  const out = new Float32Array(msToSamples(totalMs));
  for (const [a, b] of spans)
    for (let i = msToSamples(a); i < msToSamples(b); i++)
      out[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / REEL_SR);
  return out;
}

/** a scripted voice: `speechMs(text, pace)` of tone between 40 ms lead-in and 120 ms tail */
class FakeVoice implements VoiceProvider {
  readonly capability = "voice" as const;
  readonly model = "fake/1";
  readonly calls: VoiceRequest[] = [];

  constructor(
    readonly name: string,
    readonly local: boolean,
    private readonly o: {
      speechMs: (text: string, pace: number) => number;
      fail?: (call: number, req: VoiceRequest) => boolean;
      estimate?: number;
      /** provider word timings (one word per line) */
      words?: boolean;
    },
  ) {}

  available() {
    return Promise.resolve({ ok: true });
  }
  supportsLocale() {
    return true;
  }
  estimateMicros() {
    return this.local ? 0 : (this.o.estimate ?? 0);
  }

  async speak(req: VoiceRequest, c: CallContext): Promise<VoiceResult> {
    this.calls.push(req);
    if (this.o.fail?.(this.calls.length, req)) throw new Error(`${this.name} failed`);
    const ms = Math.round(this.o.speechMs(req.text, req.pace));
    const file = path.join(c.workDir, `${this.name}-${this.calls.length}.wav`);
    await writeWav16(file, [tones([[40, 40 + ms]], ms + 160)]);
    if (!this.local)
      c.tracker.record({
        capability: "voice",
        provider: this.name,
        model: this.model,
        costMicros: this.estimateMicros(),
        estimated: false,
        cached: false,
        units: { characters: req.text.length },
        scope: c.scope,
      });
    const words: WordTime[] = [{ text: req.text, startMs: 40, endMs: 40 + ms }];
    return {
      path: file,
      durationMs: ms + 160,
      voice: this.name,
      characters: req.text.length,
      cached: false,
      ...(this.o.words ? { words } : {}),
    };
  }
}

/** a 5 s plan with three voice lines */
const plan = (durationMs = 5000) =>
  testPlan({
    durationMs,
    voiceover: {
      enabled: true,
      personaId: "p",
      pace: 1,
      style: "warm",
      segments: [
        { slot: "v1", atMs: 250 },
        { slot: "v2", atMs: 2000 },
        { slot: "v3", atMs: 3500 },
      ],
    },
    copy: {
      locale: "pl-PL",
      market: "PL",
      slots: {
        v1: { kind: "voice", text: "Pierwsza" },
        v2: { kind: "voice", text: "Druga" },
        v3: { kind: "voice", text: "Trzecia" },
        cta: { kind: "cta", text: "Link w bio" },
      },
      transcreation: { provider: "master", model: "-", sourceLocale: "pl-PL", isMaster: true },
    },
  });

const speechOf = (s: { startMs: number; endMs: number }) => s.endMs - s.startMs;

describe("voice track: pace fit", () => {
  it("keeps the shorter take when a 'faster' local take is longer, and stretches it to fit", async () => {
    // 3 × 1650 ms does not fit 5 s; the re-synthesised take is LONGER (a random-duration engine)
    const piper = new FakeVoice("piper", true, { speechMs: (_t, pace) => (pace === 1 ? 1650 : 1800) });
    const r = await buildVoiceTrack({ plan: plan(), persona, voiceChain: [piper], ctx: ctx() });
    expect(piper.calls.map((c) => c.pace)).toEqual([1, 1, 1, 1.13, 1.13, 1.13]);
    expect(r.pace).toBe(1.13);
    expect(r.issues.map((i) => i.code)).toEqual(["VOICE_PACE_RAISED"]);
    for (const s of r.segments) expect(Math.abs(speechOf(s) - 1650 / 1.13)).toBeLessThan(40);
    expect(r.segments[2]!.endMs).toBeLessThanOrEqual(4850);
    expect(r.words[r.words.length - 1]!.endMs).toBeLessThanOrEqual(4850);
  });

  it("never buys a new paid take for a pace change: clip and word timings are stretched", async () => {
    const cloud = new FakeVoice("cloud", false, { speechMs: () => 1650, estimate: 100, words: true });
    const tracker = new CostTracker();
    const r = await buildVoiceTrack({
      plan: plan(),
      persona,
      voiceChain: [cloud],
      ctx: ctx(tracker),
      budget: new BudgetGate(1_000_000, tracker),
    });
    expect(cloud.calls).toHaveLength(3);
    expect(tracker.spentMicros()).toBe(300);
    expect(r.pace).toBe(1.13);
    expect(r.timingsSource).toBe("provider");
    for (const [i, s] of r.segments.entries()) {
      expect(Math.abs(speechOf(s) - 1650 / 1.13)).toBeLessThan(40);
      expect(Math.abs(speechOf(r.words[i]!) - 1650 / 1.13)).toBeLessThan(5);
    }
    expect(r.segments[2]!.endMs).toBeLessThanOrEqual(4850);
  });

  it("raises a blocker when the voice-over still runs past the end of the reel", async () => {
    const piper = new FakeVoice("piper", true, { speechMs: (_t, pace) => 2500 / pace });
    const r = await buildVoiceTrack({ plan: plan(), persona, voiceChain: [piper], ctx: ctx() });
    const overflow = r.issues.find((i) => i.code === "VOICE_OVERFLOW");
    expect(overflow?.severity).toBe("blocker");
    expect(overflow?.message).toMatch(/cut off/);
  });
});

describe("voice track: one speaker", () => {
  it("re-voices the earlier lines with the provider a later line fell back to", async () => {
    const cloud = new FakeVoice("cloud", false, { speechMs: () => 800, fail: (n) => n === 3 });
    const piper = new FakeVoice("piper", true, { speechMs: () => 800 });
    const r = await buildVoiceTrack({ plan: plan(), persona, voiceChain: [cloud, piper], ctx: ctx() });
    expect(r.provider).toBe("piper");
    expect(piper.calls.map((c) => c.text)).toEqual(["Trzecia", "Pierwsza", "Druga"]);
    expect(r.issues.map((i) => i.code)).not.toContain("VOICE_MIXED");
    expect(r.fallbacks).toEqual([expect.objectContaining({ wanted: "cloud", used: "piper" })]);
  });

  it("reports VOICE_MIXED when the earlier lines cannot be re-voiced", async () => {
    const cloud = new FakeVoice("cloud", false, { speechMs: () => 800, fail: (n) => n === 3 });
    const gemini = new FakeVoice("gemini", false, { speechMs: () => 800, fail: (n) => n > 1 });
    const r = await buildVoiceTrack({ plan: plan(), persona, voiceChain: [cloud, gemini], ctx: ctx() });
    expect(r.issues).toContainEqual(expect.objectContaining({ code: "VOICE_MIXED", severity: "major" }));
  });

  it("falls back mid-reel only to a voice the budget can carry for every line", async () => {
    // line 3 fails on cloud; gemini could pay for line 3 but not for re-voicing lines 1–2 → piper voices all
    const tracker = new CostTracker();
    const cloud = new FakeVoice("cloud", false, { speechMs: () => 800, fail: (n) => n === 3 });
    const gemini = new FakeVoice("gemini", false, { speechMs: () => 800, estimate: 400 });
    const piper = new FakeVoice("piper", true, { speechMs: () => 800 });
    const r = await buildVoiceTrack({
      plan: plan(),
      persona,
      voiceChain: [cloud, gemini, piper],
      ctx: ctx(tracker),
      budget: new BudgetGate(1000, tracker),
    });
    expect(gemini.calls).toHaveLength(0);
    expect(r.provider).toBe("piper");
    expect(r.issues.map((i) => i.code)).not.toContain("VOICE_MIXED");
  });

  it("does not start a paid voice the budget cannot carry to the last line", async () => {
    // 3 lines × 400 µUSD = 1200 > 1000: before, lines 1–2 were cloud and line 3 piper
    const tracker = new CostTracker();
    const cloud = new FakeVoice("cloud", false, { speechMs: () => 800, estimate: 400 });
    const piper = new FakeVoice("piper", true, { speechMs: () => 800 });
    const r = await buildVoiceTrack({
      plan: plan(),
      persona,
      voiceChain: [cloud, piper],
      ctx: ctx(tracker),
      budget: new BudgetGate(1000, tracker),
    });
    expect(cloud.calls).toHaveLength(0);
    expect(piper.calls).toHaveLength(3);
    expect(tracker.spentMicros()).toBe(0);
    expect(r.fallbacks[0]?.reason).toMatch(/exceeds remaining budget/);
  });
});

describe("local alignment", () => {
  it("gives no word to a fragment shorter than a syllable (Piper 'Link znajdziesz w bio.')", () => {
    // the VAD regions of the shipped e2e-lamp-3 B-pl-PL CTA clip: "Lin" · "k" release · "znajdziesz w bio."
    const samples = tones(
      [
        [50, 190],
        [310, 370],
        [460, 1670],
      ],
      1810,
    );
    expect(detectSpeech(samples, REEL_SR)).toEqual([
      { startMs: 50, endMs: 190 },
      { startMs: 310, endMs: 370 },
      { startMs: 460, endMs: 1670 },
    ]);
    const { words } = alignWordsToPcm(samples, REEL_SR, "Link znajdziesz w bio.", "pl-PL");
    const z = words.find((w) => w.text === "znajdziesz")!;
    // before: znajdziesz 310–370 and "w" highlighted 460–1033 while the voice said "znajdziesz"
    expect(z.endMs - z.startMs).toBeGreaterThan(400);
    expect(z.endMs).toBeGreaterThan(900);
    expect(words.find((w) => w.text === "w")!.startMs).toBeGreaterThan(900);
  });

  it("joins short fragments to the nearer neighbour, keeps an isolated short region", () => {
    expect(
      absorbShortRegions([
        { startMs: 0, endMs: 600 },
        { startMs: 650, endMs: 700 },
        { startMs: 800, endMs: 1400 },
        { startMs: 2000, endMs: 2100 },
        { startMs: 2600, endMs: 3000 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 700 },
      { startMs: 800, endMs: 1400 },
      { startMs: 2000, endMs: 2100 },
      { startMs: 2600, endMs: 3000 },
    ]);
  });
});

describe("ElevenLabs voice", () => {
  it("pays once per (model, voice, text): the pace is applied locally to the cached take", async () => {
    const tracker = new CostTracker();
    const c = ctx(tracker);
    let paid = 0;
    const tts: ElevenLabsTts = {
      execute: async (_req, x) => {
        paid++;
        const filePath = path.join(x.workDir, `el-${paid}.wav`);
        await writeWav16(filePath, [tones([[100, 1300]], 1500)], 44_100);
        return {
          filePath,
          durationMs: 1500,
          words: [{ text: "Hallo", startMs: 100, endMs: 1300 }],
          timingsExact: true,
          actualCostMicros: 1200,
        } as Awaited<ReturnType<ElevenLabsTts["execute"]>>;
      },
    };
    const el = new ElevenLabsVoiceProvider(
      { ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "voice1234" } as unknown as Env,
      { model: "eleven_flash_v2_5", tts: () => tts },
    );
    const req = (pace: number): VoiceRequest => ({
      text: "Hallo",
      locale: "de-DE",
      persona,
      pace,
      style: "",
    });
    const a = await el.speak(req(1), c);
    const b = await el.speak(req(1.15), c);
    const b2 = await el.speak(req(1.15), c);
    expect(paid).toBe(1);
    expect(tracker.entries.map((e) => e.costMicros)).toEqual([1200, 0, 0]);
    expect([a.cached, b.cached, b2.cached]).toEqual([false, true, true]);
    expect(a.words).toEqual([{ text: "Hallo", startMs: 100, endMs: 1300 }]);
    expect(b.words).toEqual([{ text: "Hallo", startMs: 87, endMs: 1130 }]);
    expect(b.path).toBe(b2.path);
    expect(Math.abs(b.durationMs - a.durationMs / 1.15)).toBeLessThan(30);
  });
});
