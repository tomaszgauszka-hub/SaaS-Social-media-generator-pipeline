import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FatalError, ProviderError, createLogger } from "@cre/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, stubFetch, text, type CapturedRequest, type FetchStub } from "../../../../test/fetch-stub.ts";
import { createGoogleAI, defaultSttLocation, type GoogleAIDeps, type GoogleEnv } from "./client.ts";
import { billedCostOf } from "./gemini.ts";
import { parseWav, pcmToWav } from "./media.ts";
import { TokenBucket } from "./rate-limit.ts";

/**
 * The Google client against scripted HTTP replies: request shapes per surface, auth headers, retries, error
 * mapping and cost from reported usage. No network, no keys, no spend.
 */
const GL = "https://generativelanguage.googleapis.com/v1beta/models";
const KEY = "AIza-test-key-0123456789";
const TOKEN = "ya29.test-cloud-token";
const ENV: GoogleEnv = {
  GOOGLE_API_KEY: KEY,
  GOOGLE_GENAI_BASE_URL: "https://generativelanguage.googleapis.com",
  GOOGLE_CLOUD_ACCESS_TOKEN: TOKEN,
  GOOGLE_CLOUD_PROJECT: "proj-1",
  GOOGLE_CLOUD_LOCATION: "global",
  GOOGLE_MAX_RPM: 60,
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cre-google-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const photo = path.join(tmp, "photo.png");
fs.writeFileSync(photo, png(64, 64));
const voiceWav = path.join(tmp, "voice.wav");
fs.writeFileSync(voiceWav, pcmToWav(Buffer.alloc(24_000 * 2 * 2), 24_000)); // 2 s mono

let http: FetchStub;
let sleeps: number[];
const noLimit = { acquire: () => Promise.resolve() };
const silent = createLogger({ service: "test", level: "silent" });

function ai(env: Partial<GoogleEnv> = {}, deps: GoogleAIDeps = {}) {
  return createGoogleAI(
    { ...ENV, ...env },
    {
      rateLimiter: noLimit,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
      pollIntervalMs: 5_000,
      logger: silent,
      ...deps,
    },
  );
}

/** parsed JSON request body; `at(b, "contents.0.parts.1")` reads a nested value without `any` */
function body(req: CapturedRequest | undefined): Record<string, unknown> {
  return JSON.parse(req?.body ?? "null") as Record<string, unknown>;
}

function at(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      obj,
    );
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

const usage = (prompt: number, out: number, thoughts = 0, extra: Record<string, unknown> = {}) => ({
  promptTokenCount: prompt,
  candidatesTokenCount: out,
  thoughtsTokenCount: thoughts,
  totalTokenCount: prompt + out + thoughts,
  ...extra,
});

beforeEach(() => {
  http = stubFetch();
  sleeps = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("createGoogleAI", () => {
  it("constructs without credentials and fails only when a method is called", async () => {
    const g = ai({
      GOOGLE_API_KEY: undefined,
      GOOGLE_CLOUD_ACCESS_TOKEN: undefined,
      GOOGLE_CLOUD_PROJECT: undefined,
    });
    expect(g.hasApiKey).toBe(false);
    expect(g.hasCloudToken).toBe(false);
    expect(g.hasCloudProject).toBe(false);
    const err = await rejection(g.generate({ model: "gemini-3.5-flash-lite", parts: [{ text: "hi" }] }));
    expect(err).toBeInstanceOf(FatalError);
    expect(String(err)).toMatch(/GOOGLE_API_KEY is not configured/);
    const err2 = await rejection(
      g.synthesizeWithMarks({ voiceName: "pl-PL-Wavenet-A", languageCode: "pl-PL", words: ["Kup"] }),
    );
    expect(String(err2)).toMatch(/GOOGLE_CLOUD_ACCESS_TOKEN is not configured/);
    expect(http.calls).toHaveLength(0);
  });

  it("rejects model ids that are not plain ids (they become URL paths)", async () => {
    const err = await rejection(ai().generate({ model: "../files/x", parts: [{ text: "hi" }] }));
    expect(err).toBeInstanceOf(FatalError);
    expect(http.calls).toHaveLength(0);
  });
});

describe("generate (Gemini generateContent)", () => {
  it("sends the documented request shape and parses structured output", async () => {
    http.on(
      "POST",
      `${GL}/gemini-3.5-flash-lite:generateContent`,
      json({
        candidates: [{ content: { parts: [{ text: '{"hook":"Light that works"}' }] }, finishReason: "STOP" }],
        usageMetadata: usage(1000, 200, 300, {
          promptTokensDetails: [{ modality: "TEXT", tokenCount: 1000 }],
        }),
      }),
    );
    const schema = { type: "object", properties: { hook: { type: "string" } }, required: ["hook"] };
    const res = await ai().generate({
      model: "gemini-3.5-flash-lite",
      system: "You are the director.",
      parts: [{ text: "Product facts" }, { file: photo }],
      jsonSchema: schema,
      thinkingLevel: "minimal",
      maxOutputTokens: 1024,
      mediaResolution: "medium",
      label: "reel.director",
    });
    const req = http.calls[0]!;
    expect(req.headers.get("x-goog-api-key")).toBe(KEY);
    expect(req.headers.get("authorization")).toBeNull();
    const b = body(req);
    expect(at(b, "systemInstruction")).toEqual({ parts: [{ text: "You are the director." }] });
    expect(at(b, "contents.0.role")).toBe("user");
    expect(at(b, "contents.0.parts.0")).toEqual({ text: "Product facts" });
    expect(at(b, "contents.0.parts.1.inlineData.mimeType")).toBe("image/png");
    expect(
      Buffer.from(at(b, "contents.0.parts.1.inlineData.data") as string, "base64").equals(png(64, 64)),
    ).toBe(true);
    expect(at(b, "generationConfig")).toEqual({
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      thinkingConfig: { thinkingLevel: "MINIMAL" },
      maxOutputTokens: 1024,
      mediaResolution: "MEDIA_RESOLUTION_MEDIUM",
    });
    for (const deprecated of ["temperature", "topP", "topK", "candidateCount"]) {
      expect(at(b, "generationConfig")).not.toHaveProperty(deprecated);
    }
    expect(res.json).toEqual({ hook: "Light that works" });
    expect(res.usage).toEqual({ inputTokens: 1000, outputTokens: 200, thoughtsTokens: 300, cachedTokens: 0 });
    // 1000 × $0.30/M + (200 output + 300 thinking) × $2.50/M = $0.00155
    expect(res.costMicros).toBe(1550);
    expect(res.costEstimated).toBeUndefined();
    expect(res.finishReason).toBe("STOP");
  });

  it("bills thinking tokens at the output rate even without a modality split", async () => {
    http.on(
      "POST",
      `${GL}/gemini-3.8-flash:generateContent`,
      json({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: usage(0, 100, 900) }),
    );
    const res = await ai({}, { now: () => new Date("2026-10-09T00:00:00Z") }).generate({
      model: "gemini-3.8-flash",
      parts: [{ text: "x" }],
    });
    // promptTokenCount 0 → hasUsage via candidates; 1000 output-rate tokens × $3.75/M
    expect(res.costMicros).toBe(3750);
  });

  it("applies scheduled price changes by date (3.8 Flash introductory price ends 2027-01-01)", async () => {
    http.on(
      "POST",
      `${GL}/gemini-3.8-flash:generateContent`,
      json({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: usage(1_000_000, 0) }),
    );
    const before = await ai({}, { now: () => new Date("2026-12-31T12:00:00Z") }).generate({
      model: "gemini-3.8-flash",
      parts: [{ text: "x" }],
    });
    const after = await ai({}, { now: () => new Date("2027-01-02T00:00:00Z") }).generate({
      model: "gemini-3.8-flash",
      parts: [{ text: "x" }],
    });
    expect(before.costMicros).toBe(750_000);
    expect(after.costMicros).toBe(1_500_000);
  });

  it("falls back to a flagged estimate when no usage is reported, and never prices an unknown model at 0", async () => {
    http.on(
      "POST",
      `${GL}/gemini-9-unknown:generateContent`,
      json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
    );
    const g = ai();
    const res = await g.generate({
      model: "gemini-9-unknown",
      parts: [{ text: "hello world" }],
      maxOutputTokens: 100,
    });
    expect(res.costEstimated).toBe(true);
    expect(res.costMicros).toBeGreaterThan(0);
    expect(g.estimateGenerateMicros("gemini-9-unknown", 1000, 1000)).toBeGreaterThan(
      g.estimateGenerateMicros("gemini-3.5-flash-lite", 1000, 1000),
    );
  });

  it("maps invalid JSON to a non-retryable error that still carries the billed cost", async () => {
    http.on(
      "POST",
      `${GL}/gemini-3.5-flash-lite:generateContent`,
      json({
        candidates: [{ content: { parts: [{ text: '{"hook": "cut' }] }, finishReason: "MAX_TOKENS" }],
        usageMetadata: usage(1000, 64),
      }),
    );
    const err = await rejection(
      ai().generate({
        model: "gemini-3.5-flash-lite",
        parts: [{ text: "x" }],
        jsonSchema: { type: "object" },
      }),
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("INVALID_OUTPUT");
    expect((err as ProviderError).retryable).toBe(false);
    expect((err as ProviderError).charged).toBe(true);
    expect(billedCostOf(err)).toBe(300 + 160);
  });

  it("maps blocked prompts to CONTENT_BLOCKED (not retryable)", async () => {
    http.on(
      "POST",
      `${GL}/gemini-3.5-flash-lite:generateContent`,
      json({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: usage(10, 0) }),
    );
    const err = await rejection(ai().generate({ model: "gemini-3.5-flash-lite", parts: [{ text: "x" }] }));
    expect((err as ProviderError).code).toBe("CONTENT_BLOCKED");
    expect((err as ProviderError).retryable).toBe(false);
  });
});

describe("transport: retries, errors, rate limit", () => {
  const ok = json({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: usage(1, 1) });
  const url = `${GL}/gemini-3.5-flash-lite:generateContent`;
  const call = (g = ai()) => g.generate({ model: "gemini-3.5-flash-lite", parts: [{ text: "x" }] });

  it("honours Retry-After on 429 and succeeds on the next attempt", async () => {
    http.on(
      "POST",
      url,
      json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "slow down" } }, 429, {
        "retry-after": "2",
      }),
      ok,
    );
    const res = await call();
    expect(res.text).toBe("ok");
    expect(http.calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it("uses google.rpc.RetryInfo when there is no Retry-After header", async () => {
    http.on(
      "POST",
      url,
      json(
        {
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" }],
          },
        },
        429,
      ),
      ok,
    );
    await call();
    expect(sleeps).toEqual([7000]);
  });

  it("backs off exponentially on 5xx and gives up after 3 attempts with a retryable error", async () => {
    http.on("POST", url, json({ error: { code: 503, status: "UNAVAILABLE", message: "overloaded" } }, 503));
    const err = await rejection(call(ai({}, { baseBackoffMs: 1000 })));
    expect(http.calls).toHaveLength(3);
    // equal jitter with random()=0.5: base·2^(n-1) · 0.75
    expect(sleeps).toEqual([750, 1500]);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).status).toBe(503);
  });

  it("does not retry 4xx, maps Google's error and redacts secrets", async () => {
    http.on(
      "POST",
      url,
      json({ error: { code: 400, status: "INVALID_ARGUMENT", message: `bad key ${KEY}` } }, 400),
    );
    const err = await rejection(call());
    expect(http.calls).toHaveLength(1);
    expect((err as ProviderError).retryable).toBe(false);
    expect((err as ProviderError).message).toMatch(/INVALID_ARGUMENT/);
    expect((err as ProviderError).message).not.toContain(KEY);
    expect((err as ProviderError).message).toContain("[redacted]");
  });

  it("maps 401/403 to AUTH errors", async () => {
    http.on("POST", url, text("denied", 403));
    const err = await rejection(call());
    expect((err as ProviderError).code).toBe("AUTH");
  });

  it("is abortable before any request is sent", async () => {
    http.on("POST", url, ok);
    const ac = new AbortController();
    ac.abort(new Error("cancelled by job"));
    const err = await rejection(
      ai().generate({ model: "gemini-3.5-flash-lite", parts: [{ text: "x" }], signal: ac.signal }),
    );
    expect(String(err)).toMatch(/cancelled by job/);
    expect(http.calls).toHaveLength(0);
  });

  it("acquires the rate limiter before every attempt", async () => {
    const acquire = vi.fn(() => Promise.resolve());
    http.on("POST", url, text("busy", 500), ok);
    await call(ai({}, { rateLimiter: { acquire } }));
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it("token bucket: bursts up to capacity, then waits for the refill", async () => {
    let now = 0;
    const waits: number[] = [];
    const bucket = new TokenBucket({
      perMinute: 60,
      burst: 2,
      now: () => now,
      sleep: (ms) => {
        waits.push(ms);
        now += ms;
        return Promise.resolve();
      },
    });
    await bucket.acquire();
    await bucket.acquire();
    expect(waits).toEqual([]);
    await bucket.acquire();
    expect(waits).toEqual([1000]); // 60/min → one token per second
  });
});

describe("generateImage", () => {
  it("requests IMAGE output with imageConfig, inlines references and reads the image", async () => {
    http.on(
      "POST",
      `${GL}/gemini-nano-banana-2.1:generateContent`,
      json({
        candidates: [
          {
            content: {
              parts: [
                { text: "A warm empty desk." },
                { inlineData: { mimeType: "image/png", data: png(1536, 2752).toString("base64") } },
              ],
            },
          },
        ],
        usageMetadata: usage(1500, 1680, 0, {
          promptTokensDetails: [
            { modality: "TEXT", tokenCount: 380 },
            { modality: "IMAGE", tokenCount: 1120 },
          ],
          candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1680 }],
        }),
      }),
    );
    const res = await ai().generateImage({
      model: "gemini-nano-banana-2.1",
      prompt: "background plate",
      references: [photo],
      aspectRatio: "9:16",
      imageSize: "2K",
    });
    const b = body(http.calls[0]);
    expect(at(b, "generationConfig")).toEqual({
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "9:16", imageSize: "2K" },
    });
    expect(at(b, "contents.0.parts.0")).toEqual({ text: "background plate" });
    expect(at(b, "contents.0.parts.1.inlineData.mimeType")).toBe("image/png");
    expect(res.width).toBe(1536);
    expect(res.height).toBe(2752);
    expect(res.text).toBe("A warm empty desk.");
    // 1500 input × $1.50/M + 1680 image tokens × $30/M = 0.00225 + 0.0504
    expect(res.costMicros).toBe(52_650);
  });

  it("reports NO_IMAGE when the model answers with text only", async () => {
    http.on(
      "POST",
      `${GL}/gemini-nano-banana-2.1:generateContent`,
      json({
        candidates: [{ content: { parts: [{ text: "I can't" }] }, finishReason: "NO_IMAGE" }],
        usageMetadata: usage(100, 10),
      }),
    );
    const err = await rejection(
      ai().generateImage({ model: "gemini-nano-banana-2.1", prompt: "x", aspectRatio: "9:16" }),
    );
    expect((err as ProviderError).code).toBe("NO_IMAGE");
    expect(billedCostOf(err)).toBeGreaterThan(0);
  });
});

describe("generateMusic (Lyria)", () => {
  it("asks for AUDIO+TEXT and prices per song", async () => {
    const mp3 = Buffer.from("ID3fake-mp3-bytes");
    http.on(
      "POST",
      `${GL}/lyria-3.5:generateContent`,
      json({
        candidates: [
          {
            content: {
              parts: [
                { text: "[Intro] …" },
                { inlineData: { mimeType: "audio/mpeg", data: mp3.toString("base64") } },
              ],
            },
          },
        ],
        usageMetadata: usage(120, 3000),
      }),
    );
    const g = ai();
    const res = await g.generateMusic({ model: "lyria-3.5", prompt: "Instrumental only, no vocals." });
    expect(at(body(http.calls[0]), "generationConfig")).toEqual({ responseModalities: ["AUDIO", "TEXT"] });
    expect(res.bytes.equals(mp3)).toBe(true);
    expect(res.mimeType).toBe("audio/mpeg");
    expect(res.text).toBe("[Intro] …");
    expect(res.costMicros).toBe(80_000);
    expect(g.estimateMusicMicros("lyria-3.5")).toBe(80_000);
  });
});

describe("synthesizeSpeech (Gemini TTS)", () => {
  it("sends text verbatim with speechMetadata.style and wraps raw L16 PCM in a WAV header", async () => {
    const pcm = Buffer.alloc(24_000 * 2); // 1 s mono 16-bit
    http.on(
      "POST",
      `${GL}/gemini-3.8-flash-tts:generateContent`,
      json({
        candidates: [
          {
            content: {
              parts: [
                { inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm.toString("base64") } },
              ],
            },
          },
        ],
        usageMetadata: usage(20, 25, 0, { candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 25 }] }),
      }),
    );
    const res = await ai().synthesizeSpeech({
      model: "gemini-3.8-flash-tts",
      text: "Kup teraz.",
      voice: "Kore",
      style: "warm, confident",
      languageCode: "pl-PL",
    });
    const b = body(http.calls[0]);
    expect(at(b, "contents.0.parts.0")).toEqual({
      text: "Kup teraz.",
      speechMetadata: { style: "warm, confident" },
    });
    expect(at(b, "generationConfig")).toEqual({
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { voice: "Kore" }, languageCode: "pl-PL" },
    });
    expect(res.sampleRate).toBe(24_000);
    expect(parseWav(res.wav)?.durationMs).toBe(1000);
    // 20 × $0.50/M + 25 × $9/M
    expect(res.costMicros).toBe(235);
  });

  it("passes a RIFF WAV through and uses the legacy voice shape for 2.5 preview models", async () => {
    const wav = pcmToWav(Buffer.alloc(48_000), 24_000);
    http.on(
      "POST",
      `${GL}/gemini-2.5-flash-preview-tts:generateContent`,
      json({
        candidates: [
          { content: { parts: [{ inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } }] } },
        ],
      }),
    );
    const res = await ai().synthesizeSpeech({
      model: "gemini-2.5-flash-preview-tts",
      text: "Hello",
      voice: "Puck",
      style: "upbeat",
      languageCode: "en-US",
    });
    const b = body(http.calls[0]);
    expect(at(b, "generationConfig.speechConfig.voiceConfig")).toEqual({
      prebuiltVoiceConfig: { voiceName: "Puck" },
    });
    expect(at(b, "contents.0.parts.0.text")).toContain("upbeat");
    expect(res.wav.equals(wav)).toBe(true);
    expect(res.costEstimated).toBe(true); // no usageMetadata → priced from the audio length
    expect(res.costMicros).toBeGreaterThan(0);
  });
});

describe("synthesizeWithMarks (Cloud TTS v1beta1)", () => {
  const TTS = "https://texttospeech.googleapis.com/v1beta1/text:synthesize";

  it("puts a <mark> before every escaped word and turns timepoints into word timings", async () => {
    const wav = pcmToWav(Buffer.alloc(48_000 * 2), 48_000); // 1 s
    http.on(
      "POST",
      TTS,
      json({
        audioContent: wav.toString("base64"),
        timepoints: [
          { markName: "w0", timeSeconds: 0.05 },
          { markName: "w1", timeSeconds: 0.3 },
          { markName: "w2", timeSeconds: 0.62 },
        ],
      }),
    );
    const res = await ai().synthesizeWithMarks({
      voiceName: "pl-PL-Wavenet-A",
      languageCode: "pl-PL",
      words: ["Light", "&", "<shade>"],
      speakingRate: 1.1,
    });
    const req = http.calls[0]!;
    expect(req.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(req.headers.get("x-goog-user-project")).toBe("proj-1");
    expect(req.headers.get("x-goog-api-key")).toBeNull();
    const b = body(req);
    expect(at(b, "input.ssml")).toBe(
      '<speak><mark name="w0"/>Light <mark name="w1"/>&amp; <mark name="w2"/>&lt;shade&gt;</speak>',
    );
    expect(at(b, "enableTimePointing")).toEqual(["SSML_MARK"]);
    expect(at(b, "voice")).toEqual({ languageCode: "pl-PL", name: "pl-PL-Wavenet-A" });
    expect(at(b, "audioConfig")).toEqual({
      audioEncoding: "LINEAR16",
      sampleRateHertz: 48_000,
      speakingRate: 1.1,
    });
    expect(res.words).toEqual([
      { text: "Light", startMs: 50, endMs: 300 },
      { text: "&", startMs: 300, endMs: 620 },
      { text: "<shade>", startMs: 620, endMs: 1000 },
    ]);
    expect(res.durationMs).toBe(1000);
    expect(res.sampleRate).toBe(48_000);
    // billed characters exclude <mark> tags: "<speak>Light &amp; &lt;shade&gt;</speak>"
    expect(res.characters).toBe("<speak>Light &amp; &lt;shade&gt;</speak>".length);
    expect(res.costMicros).toBe(Math.round(((res.characters! * 4) / 1_000_000) * 1e6));
  });

  it("splits long scripts under the 5000-byte input limit and offsets the timings", async () => {
    const words = Array.from({ length: 400 }, (_, i) => `słowo${i}`);
    const wav = pcmToWav(Buffer.alloc(48_000 * 2), 48_000);
    http.on("POST", TTS, (req) => {
      const ssml = at(body(req), "input.ssml") as string;
      expect(Buffer.byteLength(ssml)).toBeLessThanOrEqual(5000);
      const names = [...ssml.matchAll(/<mark name="(w\d+)"\/>/g)].map((m) => m[1]!);
      return json({
        audioContent: wav.toString("base64"),
        timepoints: names.map((markName, i) => ({ markName, timeSeconds: (i / names.length) * 0.9 })),
      });
    });
    const res = await ai().synthesizeWithMarks({
      voiceName: "pl-PL-Wavenet-A",
      languageCode: "pl-PL",
      words,
    });
    expect(http.calls.length).toBeGreaterThan(1);
    expect(res.words).toHaveLength(400);
    expect(res.durationMs).toBe(1000 * http.calls.length);
    const starts = res.words.map((w) => w.startMs);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(res.words[399]!.endMs).toBe(res.durationMs);
  });

  it("refuses to invent timings when the voice ignores <mark>", async () => {
    http.on(
      "POST",
      TTS,
      json({ audioContent: pcmToWav(Buffer.alloc(9600), 48_000).toString("base64"), timepoints: [] }),
    );
    const err = await rejection(
      ai().synthesizeWithMarks({
        voiceName: "en-US-Chirp3-HD-Aoede",
        languageCode: "en-US",
        words: ["Hi", "there"],
      }),
    );
    expect((err as ProviderError).code).toBe("NO_TIMEPOINTS");
    expect(billedCostOf(err)).toBeGreaterThan(0);
  });
});

describe("transcribe", () => {
  it("Gemini transcription: word timestamps via audioTranscriptionConfig", async () => {
    http.on(
      "POST",
      `${GL}/gemini-3.5-transcribe:generateContent`,
      json({
        candidates: [
          {
            content: {
              parts: [
                {
                  audioTranscription: {
                    text: "Kup teraz",
                    words: [
                      { word: "Kup", startOffset: "0.120s", endOffset: "0.400s" },
                      { word: "teraz", startOffset: "0.450s", endOffset: "0.900s" },
                    ],
                  },
                },
              ],
            },
          },
        ],
        usageMetadata: usage(50, 20, 0, { promptTokensDetails: [{ modality: "AUDIO", tokenCount: 50 }] }),
      }),
    );
    const res = await ai().transcribe({
      model: "gemini-3.5-transcribe",
      audioPath: voiceWav,
      languageCode: "pl-PL",
    });
    const b = body(http.calls[0]);
    expect(at(b, "contents.0.parts.0.inlineData.mimeType")).toBe("audio/wav");
    expect(at(b, "generationConfig.audioTranscriptionConfig")).toEqual({
      wordTimestamp: true,
      languageCodes: ["pl-PL"],
      mode: "VERBATIM",
    });
    expect(res.words).toEqual([
      { text: "Kup", startMs: 120, endMs: 400 },
      { text: "teraz", startMs: 450, endMs: 900 },
    ]);
    expect(res.text).toBe("Kup teraz");
    // 50 audio × $2/M + 20 × $12/M
    expect(res.costMicros).toBe(340);
  });

  it("Speech-to-Text v2 (chirp_3): regional endpoint, Bearer auth, billed duration", async () => {
    const STT = "https://us-speech.googleapis.com/v2/projects/proj-1/locations/us/recognizers/_:recognize";
    http.on(
      "POST",
      STT,
      json({
        results: [
          {
            alternatives: [
              {
                transcript: "buy now",
                words: [
                  { word: "buy", startOffset: "0.1s", endOffset: "0.3s" },
                  { word: "now", startOffset: "0.35s", endOffset: "0.7s" },
                ],
              },
            ],
          },
        ],
        metadata: { totalBilledDuration: "2s" },
      }),
    );
    const res = await ai().transcribe({ model: "chirp_3", audioPath: voiceWav, languageCode: "en-US" });
    const req = http.calls[0]!;
    expect(req.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    const b = body(req);
    expect(at(b, "config")).toEqual({
      autoDecodingConfig: {},
      model: "chirp_3",
      languageCodes: ["en-US"],
      features: { enableWordTimeOffsets: true },
    });
    expect(typeof at(b, "content")).toBe("string");
    expect(res.words.map((w) => w.text)).toEqual(["buy", "now"]);
    // 2 s × $0.016/min
    expect(res.costMicros).toBe(533);
    expect(res.costEstimated).toBeUndefined();
  });

  it("Speech-to-Text needs a project (FatalError before any request)", async () => {
    const err = await rejection(
      ai({ GOOGLE_CLOUD_PROJECT: undefined }).transcribe({
        model: "chirp_3",
        audioPath: voiceWav,
        languageCode: "en-US",
      }),
    );
    expect(err).toBeInstanceOf(FatalError);
    expect(http.calls).toHaveLength(0);
  });

  it("maps the configured location to a chirp_3 multi-region", () => {
    expect(defaultSttLocation("global")).toBe("us");
    expect(defaultSttLocation("europe-west4")).toBe("eu");
    expect(defaultSttLocation("asia-south1")).toBe("asia-south1");
  });
});

describe("embed", () => {
  it("batches one Content per item with task prefixes and outputDimensionality", async () => {
    http.on(
      "POST",
      `${GL}/gemini-embedding-2:batchEmbedContents`,
      json({
        embeddings: [{ values: [3, 4, 0, 0] }, { values: [0, 0, 5, 0] }],
        usageMetadata: {
          promptTokenCount: 300,
          promptTokenDetails: [
            { modality: "TEXT", tokenCount: 42 },
            { modality: "IMAGE", tokenCount: 258 },
          ],
        },
      }),
    );
    const res = await ai().embed({
      model: "gemini-embedding-2",
      dimensions: 3,
      role: "query",
      items: [
        { id: "q", text: "brass desk lamp" },
        { id: "img", imagePath: photo, text: "photo" },
      ],
    });
    const b = body(http.calls[0]);
    expect(at(b, "requests")).toHaveLength(2);
    expect(at(b, "requests.0")).toEqual({
      model: "models/gemini-embedding-2",
      content: { parts: [{ text: "task: search result | query: brass desk lamp" }] },
      embedContentConfig: { outputDimensionality: 3 },
    });
    expect(at(b, "requests.1.content.parts.1.inlineData.mimeType")).toBe("image/png");
    expect(res.vectors[0]).toEqual({ id: "q", vector: [0.6, 0.8, 0] });
    expect(res.vectors[1]).toEqual({ id: "img", vector: [0, 0, 1] });
    // 42 × $0.20/M + 258 × $0.45/M = 8.4 + 116.1
    expect(res.costMicros).toBe(125);
  });

  it("uses the document prefix by default", async () => {
    http.on(
      "POST",
      `${GL}/gemini-embedding-2:batchEmbedContents`,
      json({ embeddings: [{ values: [1, 0] }] }),
    );
    const res = await ai().embed({
      model: "gemini-embedding-2",
      dimensions: 2,
      items: [{ id: "a", text: "walnut base" }],
    });
    expect(at(body(http.calls[0]), "requests.0.content.parts.0.text")).toBe(
      "title: none | text: walnut base",
    );
    expect(res.costEstimated).toBe(true);
  });
});

describe("generateVideo (Veo)", () => {
  it("Agent Platform: predictLongRunning → onOperation → fetchPredictOperation → inline bytes", async () => {
    const AP =
      "https://us-central1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001";
    const opName =
      "projects/proj-1/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001/operations/op-123";
    const video = Buffer.from("fake-mp4");
    http.on("POST", `${AP}:predictLongRunning`, json({ name: opName })).on(
      "POST",
      `${AP}:fetchPredictOperation`,
      json({ name: opName, done: false }),
      json({
        name: opName,
        done: true,
        response: { videos: [{ bytesBase64Encoded: video.toString("base64"), mimeType: "video/mp4" }] },
      }),
    );
    const onOperation = vi.fn();
    const res = await ai().generateVideo({
      model: "veo-3.1-fast-generate-001",
      prompt: "slow light sweep",
      seconds: 2,
      aspectRatio: "9:16",
      firstFramePath: photo,
      negativePrompt: "changed logo",
      seed: 42,
      onOperation,
    });
    const start = body(http.calls[0]);
    expect(http.calls[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(at(start, "instances.0.prompt")).toBe("slow light sweep");
    expect(at(start, "instances.0.image.mimeType")).toBe("image/png");
    expect(typeof at(start, "instances.0.image.bytesBase64Encoded")).toBe("string");
    expect(at(start, "parameters")).toEqual({
      aspectRatio: "9:16",
      durationSeconds: 4,
      negativePrompt: "changed logo",
      sampleCount: 1,
      generateAudio: false,
      seed: 42,
    });
    expect(onOperation).toHaveBeenCalledWith(opName);
    expect(body(http.calls[1])).toEqual({ operationName: opName });
    expect(http.calls).toHaveLength(3);
    expect(res.bytes.equals(video)).toBe(true);
    expect(res.durationMs).toBe(4000);
    expect(res.operationName).toBe(opName);
    // 4 s (minimum) × $0.08/s video-only
    expect(res.costMicros).toBe(320_000);
  });

  it("resumes an operation by name without submitting (and paying) twice", async () => {
    const AP =
      "https://us-central1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001";
    const opName =
      "projects/proj-1/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001/operations/op-9";
    http.on(
      "POST",
      `${AP}:fetchPredictOperation`,
      json({
        done: true,
        response: { videos: [{ bytesBase64Encoded: Buffer.from("v").toString("base64") }] },
      }),
    );
    await ai().generateVideo({
      model: "veo-3.1-fast-generate-001",
      prompt: "x",
      seconds: 4,
      aspectRatio: "9:16",
      operationName: opName,
    });
    expect(http.callsTo(`${AP}:predictLongRunning`)).toHaveLength(0);
    expect(http.calls).toHaveLength(1);
  });

  it("Gemini API preview ids: GET operations, download with the key, follow the redirect without it", async () => {
    const opName = "models/veo-3.1-fast-generate-preview/operations/abc";
    const fileUri = "https://generativelanguage.googleapis.com/v1beta/files/xyz:download?alt=media";
    http
      .on("POST", `${GL}/veo-3.1-fast-generate-preview:predictLongRunning`, json({ name: opName }))
      .on(
        "GET",
        `https://generativelanguage.googleapis.com/v1beta/${opName}`,
        json({
          done: true,
          response: { generateVideoResponse: { generatedSamples: [{ video: { uri: fileUri } }] } },
        }),
      )
      .on(
        "GET",
        "https://generativelanguage.googleapis.com/v1beta/files/xyz:download",
        new Response(null, {
          status: 302,
          headers: { location: "https://storage.example.com/signed/video.mp4" },
        }),
      )
      .on("GET", "https://storage.example.com/signed/video.mp4", new Response(Buffer.from("mp4!")));
    const res = await ai().generateVideo({
      model: "veo-3.1-fast-generate-preview",
      prompt: "x",
      seconds: 4,
      aspectRatio: "9:16",
      seed: 7,
    });
    const start = body(http.calls[0]);
    expect(at(start, "parameters")).toEqual({ aspectRatio: "9:16", durationSeconds: 4 }); // no seed / generateAudio on the Gemini API
    const dl = http.callsTo("https://generativelanguage.googleapis.com/v1beta/files/xyz:download")[0]!;
    expect(dl.headers.get("x-goog-api-key")).toBe(KEY);
    const signed = http.callsTo("https://storage.example.com/signed/video.mp4")[0]!;
    expect(signed.headers.get("x-goog-api-key")).toBeNull();
    expect(res.bytes.toString()).toBe("mp4!");
    // audio is always on there: 4 s × $0.10/s
    expect(res.costMicros).toBe(400_000);
  });

  it("times out with a retryable error that names the operation (resume later)", async () => {
    const opName = "models/veo-3.1-fast-generate-preview/operations/slow";
    http
      .on("POST", `${GL}/veo-3.1-fast-generate-preview:predictLongRunning`, json({ name: opName }))
      .on("GET", `https://generativelanguage.googleapis.com/v1beta/${opName}`, json({ done: false }));
    const err = await rejection(
      ai().generateVideo({
        model: "veo-3.1-fast-generate-preview",
        prompt: "x",
        seconds: 4,
        aspectRatio: "9:16",
        timeoutMs: 1,
      }),
    );
    expect((err as ProviderError).code).toBe("TIMEOUT");
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).details?.operationName).toBe(opName);
  });

  it("does not retry the submit (a retry could bill a second generation)", async () => {
    http.on("POST", `${GL}/veo-3.1-fast-generate-preview:predictLongRunning`, text("oops", 503));
    await rejection(
      ai().generateVideo({
        model: "veo-3.1-fast-generate-preview",
        prompt: "x",
        seconds: 4,
        aspectRatio: "9:16",
      }),
    );
    expect(http.calls).toHaveLength(1);
  });

  it("estimates the billed Veo duration (4 / 6 / 8 s)", () => {
    const g = ai();
    expect(g.estimateVideoMicros("veo-3.1-fast-generate-001", 1.5, false)).toBe(320_000);
    expect(g.estimateVideoMicros("veo-3.1-fast-generate-001", 5, true)).toBe(600_000);
    expect(g.estimateVideoMicros("veo-9-unknown", 2, false)).toBeGreaterThan(0);
  });
});
