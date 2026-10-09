import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "@cre/config";
import { billedError, parseWav, pcmToWav, type GoogleAI } from "@cre/providers";
import { FatalError, ProviderError } from "@cre/shared";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { CallContext } from "../../capabilities/types.ts";
import { MusicIntent } from "../../contracts/plan.ts";
import { VoicePersona } from "../../contracts/profiles.ts";
import { CostTracker } from "../../cost/tracker.ts";
import { buildImagePrompt, PRODUCT_GUARD } from "./image.ts";
import { createGoogleProviders } from "./index.ts";
import { buildLyriaPrompt, LYRIA_LICENSE, musicSections } from "./music.ts";
import { matchesScript } from "./transcription.ts";
import { veoPrompt } from "./video.ts";
import { geminiTtsStyle, paceDirection } from "./voice.ts";

/**
 * Google capability wrappers against a fake GoogleAI: availability rules, deterministic prompts, cost records,
 * cache hits at cost 0, billed failures, operation resume. FFmpeg (decode / resample / trim) runs for real when
 * it is installed.
 */
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cre-reel-google-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const KEYS = { GOOGLE_API_KEY: "k-123456", GOOGLE_CLOUD_ACCESS_TOKEN: "t-123456", GOOGLE_CLOUD_PROJECT: "p" };
const env = (over: Record<string, string> = {}) => parseEnv({ ...KEYS, ...over });

function fakeAI(
  over: Partial<GoogleAI> = {},
  flags: Partial<Pick<GoogleAI, "hasApiKey" | "hasCloudToken" | "hasCloudProject">> = {},
): GoogleAI {
  const missing = (name: string) => () => Promise.reject(new Error(`${name} not stubbed`));
  return {
    hasApiKey: true,
    hasCloudToken: true,
    hasCloudProject: true,
    ...flags,
    generate: missing("generate"),
    generateImage: missing("generateImage"),
    generateMusic: missing("generateMusic"),
    synthesizeSpeech: missing("synthesizeSpeech"),
    synthesizeWithMarks: missing("synthesizeWithMarks"),
    transcribe: missing("transcribe"),
    embed: missing("embed"),
    generateVideo: missing("generateVideo"),
    estimateGenerateMicros: () => 1,
    estimateImageMicros: () => 50_400,
    estimateMusicMicros: () => 80_000,
    estimateSpeechMicros: () => 120,
    estimateTranscriptionMicros: () => 50,
    estimateEmbedMicros: () => 10,
    estimateVideoMicros: () => 320_000,
    ...over,
  };
}

let ctxN = 0;
function ctx(cacheDir = path.join(tmp, `cache-${++ctxN}`)): CallContext & { tracker: CostTracker } {
  return { workDir: path.join(tmp, "work"), cacheDir, scope: "pl-PL", tracker: new CostTracker() };
}

const persona = VoicePersona.parse({
  id: "warm",
  description: "warm brand voice",
  style: "warm, confident commercial read",
  gender: "female",
  voices: { google: { "de-DE": "Charon", "*": "Aoede" }, cloudtts: { "en-US": "en-US-Neural2-C" } },
});

const intent = MusicIntent.parse({
  genre: "cinematic",
  mood: "confident",
  bpm: 112,
  energy: 0.7,
  durationMs: 15_000,
  brandFeel: "premium\nwalnut [brass]",
  events: [
    { timeMs: 9_000, event: "riser", energy: 0.8 },
    { timeMs: 11_000, event: "drop", energy: 0.95 },
    { timeMs: 13_400, event: "final_hit" },
  ],
  seed: "job-1",
});

function sh(args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

describe("availability (no money spent, no keys → unavailable)", () => {
  it("every wrapper is unavailable without credentials", async () => {
    const ai = fakeAI({}, { hasApiKey: false, hasCloudToken: false, hasCloudProject: false });
    const p = createGoogleProviders(
      env({
        GOOGLE_MUSIC_COMMERCIAL_USE: "true",
        GENERATIVE_VIDEO_ENABLED: "true",
        REEL_MAX_GENERATIVE_VIDEO_SECONDS: "2",
      }),
      ai,
    );
    for (const provider of [
      p.music,
      p.geminiTts,
      p.cloudTts,
      p.transcription,
      p.image,
      p.embedding,
      p.embeddingQuery,
      p.video,
    ]) {
      const a = await provider.available();
      expect(a.ok, provider.name).toBe(false);
      expect(a.reason).toBeTruthy();
      expect(provider.local).toBe(false);
    }
  });

  it("Lyria needs the commercial-use flag OR a declared non-commercial reel", async () => {
    expect((await createGoogleProviders(env(), fakeAI()).music.available()).reason).toMatch(/COMMERCIAL_USE/);
    expect(
      (await createGoogleProviders(env({ GOOGLE_MUSIC_COMMERCIAL_USE: "true" }), fakeAI()).music.available())
        .ok,
    ).toBe(true);
    expect(
      (await createGoogleProviders(env(), fakeAI(), { nonCommercialUse: true }).music.available()).ok,
    ).toBe(true);
  });

  it("Veo is off unless GENERATIVE_VIDEO_ENABLED and a seconds cap are set; Agent Platform needs token + project", async () => {
    expect((await createGoogleProviders(env(), fakeAI()).video.available()).reason).toMatch(
      /GENERATIVE_VIDEO_ENABLED/,
    );
    const on = env({ GENERATIVE_VIDEO_ENABLED: "true", REEL_MAX_GENERATIVE_VIDEO_SECONDS: "2" });
    expect(
      (
        await createGoogleProviders(
          { ...on, REEL_MAX_GENERATIVE_VIDEO_SECONDS: 0 },
          fakeAI(),
        ).video.available()
      ).ok,
    ).toBe(false);
    expect((await createGoogleProviders(on, fakeAI()).video.available()).ok).toBe(true);
    expect(
      (await createGoogleProviders(on, fakeAI({}, { hasCloudProject: false })).video.available()).reason,
    ).toMatch(/PROJECT/);
  });

  it("transcription availability follows the configured model's surface", async () => {
    const gemini = createGoogleProviders(env(), fakeAI({}, { hasCloudToken: false })).transcription;
    expect((await gemini.available()).ok).toBe(true);
    const chirp = createGoogleProviders(
      env({ GOOGLE_TRANSCRIPTION_MODEL: "chirp_3" }),
      fakeAI({}, { hasCloudToken: false }),
    ).transcription;
    expect((await chirp.available()).reason).toMatch(/ACCESS_TOKEN/);
  });

  it("model ids come from configuration", () => {
    const p = createGoogleProviders(
      env({
        GOOGLE_MUSIC_MODEL: "lyria-x",
        GOOGLE_TTS_MODEL: "tts-x",
        GOOGLE_IMAGE_MODEL: "img-x",
        GOOGLE_EMBEDDING_DIMENSIONS: "1536",
      }),
      fakeAI(),
    );
    expect(p.music.model).toBe("lyria-x");
    expect(p.geminiTts.model).toBe("tts-x");
    expect(p.image.model).toBe("img-x");
    expect(p.embedding.dimensions).toBe(1536);
    expect(p.embeddingQuery.dimensions).toBe(1536);
  });
});

describe("Lyria prompt", () => {
  it("is deterministic, timestamped, sanitised and instrumental", () => {
    const prompt = buildLyriaPrompt(intent);
    expect(buildLyriaPrompt(intent)).toBe(prompt);
    expect(prompt).toContain("Tempo: 112 BPM");
    expect(prompt).toContain("Length: exactly 15 seconds (0:15).");
    expect(prompt).toContain("Brand feel: premium walnut brass.");
    expect(prompt).toContain("[0:00 - 0:09] Intro");
    expect(prompt).toContain("[0:09 - 0:11] Riser");
    expect(prompt).toContain("[0:11 - 0:13] Drop");
    expect(prompt).toContain("[0:13 - 0:15] Final hit");
    expect(prompt.trim().endsWith("Instrumental only, no vocals.")).toBe(true);
  });

  it("covers the whole duration without events and merges sub-second events", () => {
    const plain = musicSections(MusicIntent.parse({ ...intent, events: [] }));
    expect(plain[0]!.from).toBe(0);
    expect(plain[plain.length - 1]!.to).toBe(15);
    const close = musicSections(
      MusicIntent.parse({
        ...intent,
        events: [
          { timeMs: 12_200, event: "drop" },
          { timeMs: 12_400, event: "final_hit" },
        ],
      }),
    );
    expect(close.map((s) => [s.from, s.to])).toEqual([
      [0, 12],
      [12, 15],
    ]);
    expect(close[1]!.text).toMatch(/Drop.*Final hit/);
  });
});

describe.skipIf(!hasFfmpeg)("GoogleLyriaMusicProvider.compose", () => {
  const mp3 = path.join(tmp, "song.mp3");

  it("decodes Lyria MP3 to 48 kHz stereo WAV, records the cost, then serves the cache at cost 0", async () => {
    sh(["-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:a", "libmp3lame", "-b:a", "96k", mp3]);
    const generateMusic = vi.fn(() =>
      Promise.resolve({
        bytes: fs.readFileSync(mp3),
        mimeType: "audio/mpeg",
        text: "[Intro]",
        costMicros: 80_000,
        model: "lyria-3.5",
        latencyMs: 900,
      }),
    );
    const p = createGoogleProviders(
      env({ GOOGLE_MUSIC_COMMERCIAL_USE: "true" }),
      fakeAI({ generateMusic }),
    ).music;
    const c = ctx();
    const first = await p.compose(intent, c);
    expect(first.cached).toBe(false);
    expect(first.bpm).toBe(112);
    expect(first.license).toBe(LYRIA_LICENSE);
    const info = parseWav(fs.readFileSync(first.path))!;
    expect(info.sampleRate).toBe(48_000);
    expect(info.channels).toBe(2);
    expect(Math.abs(first.durationMs - 2000)).toBeLessThan(150);
    expect(generateMusic).toHaveBeenCalledWith(
      expect.objectContaining({ model: "lyria-3.5", prompt: buildLyriaPrompt(intent) }),
    );
    expect(c.tracker.entries).toEqual([
      expect.objectContaining({
        capability: "music",
        provider: "google",
        model: "lyria-3.5",
        costMicros: 80_000,
        estimated: false,
        cached: false,
        scope: "pl-PL",
        latencyMs: 900,
        units: { songs: 1 },
      }),
    ]);

    const again = await p.compose(intent, c);
    expect(again).toEqual({ ...first, cached: true });
    expect(generateMusic).toHaveBeenCalledTimes(1);
    expect(c.tracker.entries[1]).toEqual(
      expect.objectContaining({ costMicros: 0, cached: true, capability: "music" }),
    );
    expect(c.tracker.spentMicros()).toBe(80_000);
  });

  it("two parallel variants pay for the same song once", async () => {
    let calls = 0;
    const generateMusic = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 50));
      return { bytes: fs.readFileSync(mp3), mimeType: "audio/mpeg", costMicros: 80_000, model: "lyria-3.5" };
    });
    const p = createGoogleProviders(
      env({ GOOGLE_MUSIC_COMMERCIAL_USE: "true" }),
      fakeAI({ generateMusic }),
    ).music;
    const c = ctx();
    const [a, b] = await Promise.all([p.compose(intent, c), p.compose(intent, c)]);
    expect(calls).toBe(1);
    expect(a.path).toBe(b.path);
    expect(c.tracker.spentMicros()).toBe(80_000);
  });
});

describe("billed failures", () => {
  it("records the spend of a failed-but-billed call, then rethrows for the chain to fall back", async () => {
    const generateMusic = vi.fn(() =>
      Promise.reject(billedError("no audio", { code: "NO_AUDIO", retryable: true, costMicros: 80_000 })),
    );
    const p = createGoogleProviders(
      env({ GOOGLE_MUSIC_COMMERCIAL_USE: "true" }),
      fakeAI({ generateMusic }),
    ).music;
    const c = ctx();
    await expect(p.compose(intent, c)).rejects.toBeInstanceOf(ProviderError);
    expect(c.tracker.entries).toEqual([
      expect.objectContaining({ costMicros: 80_000, estimated: true, cached: false }),
    ]);
    expect(c.tracker.entries[0]!.note).toMatch(/failed/);
  });
});

describe("voice", () => {
  it("Gemini TTS: voice from persona per locale, '*' fallback, then GOOGLE_TTS_VOICE; style carries the pace", () => {
    const g = createGoogleProviders(env({ GOOGLE_TTS_VOICE: "Kore" }), fakeAI()).geminiTts;
    expect(g.voiceFor({ locale: "de-DE", persona })).toBe("Charon");
    expect(g.voiceFor({ locale: "pl-PL", persona })).toBe("Aoede");
    expect(g.voiceFor({ locale: "pl-PL", persona: VoicePersona.parse({ id: "x", description: "" }) })).toBe(
      "Kore",
    );
    expect(g.supportsLocale("pl-PL")).toBe(true);
    expect(g.supportsLocale("xx-XX")).toBe(false);
    expect(paceDirection(1.15)).toBe("Pace: brisk (about 1.15x a normal speaking rate).");
    expect(geminiTtsStyle(persona, { style: "excited about the lamp", pace: 1 })).toBe(
      "warm, confident commercial read. excited about the lamp. Pace: natural (about 1.00x a normal speaking rate).",
    );
  });

  it.skipIf(!hasFfmpeg)("Gemini TTS: resamples to 48 kHz mono, no word timings, cached", async () => {
    const synthesizeSpeech = vi.fn(() =>
      Promise.resolve({
        wav: pcmToWav(Buffer.alloc(24_000 * 2), 24_000),
        sampleRate: 24_000,
        costMicros: 235,
        model: "gemini-3.8-flash-tts",
        usage: { inputTokens: 20, outputTokens: 25, thoughtsTokens: 0, cachedTokens: 0 },
      }),
    );
    const g = createGoogleProviders(env(), fakeAI({ synthesizeSpeech })).geminiTts;
    const c = ctx();
    const req = { text: "Kup teraz.", locale: "pl-PL", persona, pace: 1.1, style: "" };
    const res = await g.speak(req, c);
    expect(res.words).toBeUndefined();
    expect(res.voice).toBe("Aoede");
    expect(res.characters).toBe(10);
    const info = parseWav(fs.readFileSync(res.path))!;
    expect([info.sampleRate, info.channels]).toEqual([48_000, 1]);
    expect(Math.abs(res.durationMs - 1000)).toBeLessThan(30);
    expect(synthesizeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "Aoede", languageCode: "pl-PL", text: "Kup teraz." }),
    );
    expect(c.tracker.entries[0]).toEqual(
      expect.objectContaining({ capability: "voice", costMicros: 235, inputTokens: 20, outputTokens: 25 }),
    );
    expect((await g.speak(req, c)).cached).toBe(true);
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
  });

  it("Cloud TTS marks: exact word timings, voice per locale / gender / persona, cached", async () => {
    const synthesizeWithMarks = vi.fn((req: Parameters<GoogleAI["synthesizeWithMarks"]>[0]) =>
      Promise.resolve({
        audio: pcmToWav(Buffer.alloc(48_000 * 2), 48_000),
        mimeType: "audio/wav",
        words: req.words.map((text, i) => ({ text, startMs: i * 300, endMs: (i + 1) * 300 })),
        costMicros: 160,
        characters: 40,
        sampleRate: 48_000,
        durationMs: 1000,
      }),
    );
    const p = createGoogleProviders(env(), fakeAI({ synthesizeWithMarks }));
    const c = ctx();
    const req = { text: "Lampa  z mosiądzu", locale: "pl-PL", persona, pace: 1.05, style: "" };
    const res = await p.cloudTts.speak(req, c);
    expect(res.voice).toBe("pl-PL-Wavenet-A"); // female default
    expect(res.words).toEqual([
      { text: "Lampa", startMs: 0, endMs: 300 },
      { text: "z", startMs: 300, endMs: 600 },
      { text: "mosiądzu", startMs: 600, endMs: 900 },
    ]);
    expect(synthesizeWithMarks).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceName: "pl-PL-Wavenet-A",
        languageCode: "pl-PL",
        words: ["Lampa", "z", "mosiądzu"],
        speakingRate: 1.05,
        sampleRateHertz: 48_000,
      }),
    );
    expect(c.tracker.entries[0]).toEqual(
      expect.objectContaining({ model: "pl-PL-Wavenet-A", costMicros: 160, units: { characters: 40 } }),
    );
    expect(p.cloudTts.voiceFor({ locale: "en-US", persona })).toBe("en-US-Neural2-C"); // persona override
    expect(p.cloudTts.voiceFor({ locale: "de-AT", persona: { ...persona, gender: "male" } })).toBe(
      "de-DE-Neural2-D",
    );
    expect(p.cloudTts.supportsLocale("ja-JP")).toBe(false);
    // estimates never throw (runChain estimates outside its try): unknown locale → pessimistic price
    expect(() => p.cloudTts.estimateMicros({ ...req, locale: "ja-JP" })).not.toThrow();
    const hit = await p.cloudTts.speak(req, c);
    expect(hit.cached).toBe(true);
    expect(hit.words).toEqual(res.words);
    expect(synthesizeWithMarks).toHaveBeenCalledTimes(1);
  });
});

describe("transcription", () => {
  it("returns ASR words, flags whether they match the script, caches by audio content", async () => {
    const audio = path.join(tmp, "vo.wav");
    fs.writeFileSync(audio, pcmToWav(Buffer.alloc(9600), 48_000));
    const words = [
      { text: "Kup", startMs: 100, endMs: 300 },
      { text: "teraz!", startMs: 320, endMs: 700 },
    ];
    const transcribe = vi.fn(() =>
      Promise.resolve({ words, text: "Kup teraz!", costMicros: 340, model: "gemini-3.5-transcribe" }),
    );
    const t = createGoogleProviders(env(), fakeAI({ transcribe })).transcription;
    const c = ctx();
    expect(
      await t.transcribe({ path: audio, locale: "pl-PL", expectedText: "kup, teraz", durationMs: 100 }, c),
    ).toEqual({ words, exact: true });
    expect(
      (
        await t.transcribe(
          { path: audio, locale: "pl-PL", expectedText: "kup teraz lampę", durationMs: 100 },
          c,
        )
      ).exact,
    ).toBe(false);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(c.tracker.entries.map((e) => [e.costMicros, e.cached])).toEqual([
      [340, false],
      [0, true],
    ]);
    expect(matchesScript(words, "KUP TERAZ")).toBe(true);
  });
});

describe("image", () => {
  it("prefixes every prompt with the product guard and refuses other purposes", async () => {
    expect(buildImagePrompt({ purpose: "background_plate", prompt: "warm oak desk at dusk" })).toMatch(
      new RegExp(`^${PRODUCT_GUARD.slice(0, 40)}[\\s\\S]*Scene: warm oak desk at dusk$`),
    );
    const generateImage = vi.fn();
    const img = createGoogleProviders(env(), fakeAI({ generateImage })).image;
    await expect(
      img.generate(
        { purpose: "product_shot" as never, prompt: "the lamp", aspect: "9:16", seed: "s" },
        ctx(),
      ),
    ).rejects.toBeInstanceOf(FatalError);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("writes the image into the cache and serves the second call from it", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const generateImage = vi.fn((_req: Parameters<GoogleAI["generateImage"]>[0]) =>
      Promise.resolve({
        bytes: png,
        mimeType: "image/png",
        width: 1536,
        height: 2752,
        costMicros: 52_650,
        model: "gemini-nano-banana-2.1",
      }),
    );
    const img = createGoogleProviders(env(), fakeAI({ generateImage })).image;
    const c = ctx();
    const req = {
      purpose: "background_plate" as const,
      prompt: "studio",
      aspect: "9:16" as const,
      seed: "s1",
    };
    const res = await img.generate(req, c);
    expect(res).toEqual(expect.objectContaining({ width: 1536, height: 2752, cached: false }));
    expect(res.path.endsWith("image.png")).toBe(true);
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ aspectRatio: "9:16", imageSize: "2K" }),
    );
    expect(generateImage.mock.calls[0]![0].prompt.startsWith(PRODUCT_GUARD)).toBe(true);
    expect((await img.generate(req, c)).cached).toBe(true);
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(c.tracker.spentMicros()).toBe(52_650);
  });
});

describe("embedding", () => {
  it("caches per item, only pays for new items, keeps order and passes the role", async () => {
    const embed = vi.fn((req: Parameters<GoogleAI["embed"]>[0]) =>
      Promise.resolve({
        vectors: req.items.map((it) => ({
          id: it.id,
          vector: Array.from({ length: req.dimensions }, (_, k) => (k === 0 ? Number(it.id) + 1 : 0)),
        })),
        costMicros: 7 * req.items.length,
      }),
    );
    const p = createGoogleProviders(env({ GOOGLE_EMBEDDING_DIMENSIONS: "128" }), fakeAI({ embed }));
    const docs = p.embedding;
    const c = ctx();
    const first = await docs.embed(
      [
        { id: "a", text: "walnut" },
        { id: "b", text: "brass" },
      ],
      c,
    );
    expect(first.map((v) => v.id)).toEqual(["a", "b"]);
    expect(embed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "document",
        items: [expect.objectContaining({ text: "walnut" }), expect.objectContaining({ text: "brass" })],
      }),
    );
    const second = await docs.embed(
      [
        { id: "b2", text: "brass" },
        { id: "c", text: "linen" },
      ],
      c,
    );
    expect(second.map((v) => v.id)).toEqual(["b2", "c"]);
    expect(second[0]!.vector).toEqual(first[1]!.vector);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(embed.mock.calls[1]![0].items).toHaveLength(1);
    expect(c.tracker.entries.map((e) => [e.costMicros, e.cached, e.units.items])).toEqual([
      [14, false, 2],
      [0, true, 1],
      [7, false, 1],
    ]);
    expect(p.embeddingQuery.role).toBe("query");
    expect(p.embeddingQuery.name).not.toBe(p.embedding.name);
  });
});

describe("Veo", () => {
  const on = () => env({ GENERATIVE_VIDEO_ENABLED: "true", REEL_MAX_GENERATIVE_VIDEO_SECONDS: "2" });

  it("guards the product in the prompt and enforces the seconds cap", async () => {
    expect(veoPrompt({ prompt: "light sweep", firstFramePath: "/x.png" })).toMatch(
      /product in the first frame must stay exactly/,
    );
    expect(veoPrompt({ prompt: "abstract" })).toMatch(/no product/);
    const generateVideo = vi.fn();
    const v = createGoogleProviders(on(), fakeAI({ generateVideo })).video;
    await expect(v.generate({ prompt: "x", seconds: 3, aspect: "9:16", seed: "s" }, ctx())).rejects.toThrow(
      /exceeds/,
    );
    expect(generateVideo).not.toHaveBeenCalled();
  });

  it.skipIf(!hasFfmpeg)(
    "persists the operation, resumes it after a timeout, trims to the requested length",
    async () => {
      const raw = path.join(tmp, "veo.mp4");
      sh([
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=360x640:rate=24:duration=4",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        raw,
      ]);
      const op =
        "projects/p/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001/operations/o1";
      const generateVideo = vi
        .fn<GoogleAI["generateVideo"]>()
        .mockImplementationOnce(async (req) => {
          await req.onOperation?.(op);
          throw new ProviderError("google", "still running", {
            code: "TIMEOUT",
            retryable: true,
            charged: true,
          });
        })
        .mockImplementationOnce((req) => {
          expect(req.operationName).toBe(op);
          expect(req.generateAudio).toBe(false);
          expect(typeof req.seed).toBe("number");
          return Promise.resolve({
            bytes: fs.readFileSync(raw),
            durationMs: 4000,
            costMicros: 320_000,
            model: "veo-3.1-fast-generate-001",
            mimeType: "video/mp4",
            operationName: op,
          });
        });
      const v = createGoogleProviders(on(), fakeAI({ generateVideo })).video;
      const c = ctx();
      const req = { prompt: "slow light sweep", seconds: 1.5, aspect: "9:16" as const, seed: "s" };
      await expect(v.generate(req, c)).rejects.toThrow(/still running/);
      expect(c.tracker.entries).toHaveLength(0); // nothing billed is known yet
      const res = await v.generate(req, c);
      expect(Math.abs(res.durationMs - 1500)).toBeLessThan(100);
      expect(res.cached).toBe(false);
      expect(c.tracker.entries).toEqual([
        expect.objectContaining({
          capability: "generative_video",
          costMicros: 320_000,
          units: { videoSeconds: 4 },
        }),
      ]);
      expect((await v.generate(req, c)).cached).toBe(true);
      expect(generateVideo).toHaveBeenCalledTimes(2);
    },
  );
});
