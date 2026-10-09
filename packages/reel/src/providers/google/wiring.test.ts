import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "@cre/config";
import { createGoogleAI, parseWav, pcmToWav } from "@cre/providers";
import { createLogger } from "@cre/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, stubFetch, type FetchStub } from "../../../../../test/fetch-stub.ts";
import { runChain } from "../../capabilities/chain.ts";
import type { CallContext, VoiceProvider } from "../../capabilities/types.ts";
import { VoicePersona } from "../../contracts/profiles.ts";
import { BudgetGate, CostTracker } from "../../cost/tracker.ts";
import { createGoogleProviders } from "./index.ts";

/**
 * The real Google client under the wrappers, with scripted HTTP replies: the configured model reaches the URL,
 * reported usage becomes the recorded cost, the cache makes the second call free, and with no keys the chain
 * skips Google without any request.
 */
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cre-reel-google-wiring-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const silent = createLogger({ service: "test", level: "silent" });
const persona = VoicePersona.parse({ id: "p", description: "brand voice", gender: "female" });

let http: FetchStub;
beforeEach(() => {
  http = stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

function ctx(name: string): CallContext & { tracker: CostTracker } {
  return { workDir: tmp, cacheDir: path.join(tmp, name), scope: "master", tracker: new CostTracker() };
}

describe("Google wrappers on the real client", () => {
  it.skipIf(!hasFfmpeg)(
    "Gemini TTS: configured model in the URL, usage → cost, cache hit is free",
    async () => {
      const env = parseEnv({
        GOOGLE_API_KEY: "AIza-test-0123456789",
        GOOGLE_TTS_MODEL: "gemini-3.8-flash-tts",
      });
      const ai = createGoogleAI(env, { rateLimiter: { acquire: () => Promise.resolve() }, logger: silent });
      const pcm = Buffer.alloc(24_000 * 2);
      http.on(
        "POST",
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent",
        json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm.toString("base64") },
                  },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 30,
            candidatesTokenCount: 25,
            candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 25 }],
          },
        }),
      );
      const voice = createGoogleProviders(env, ai).geminiTts;
      const c = ctx("tts");
      const req = { text: "Mosiężna lampa.", locale: "pl-PL", persona, pace: 1, style: "calm" };
      const res = await voice.speak(req, c);
      expect(parseWav(fs.readFileSync(res.path))?.sampleRate).toBe(48_000);
      expect(c.tracker.entries[0]).toEqual(
        expect.objectContaining({
          model: "gemini-3.8-flash-tts",
          costMicros: 240,
          estimated: false,
          inputTokens: 30,
          outputTokens: 25,
        }),
      );
      await voice.speak(req, c);
      expect(http.calls).toHaveLength(1);
      expect(c.tracker.spentMicros()).toBe(240);
    },
  );

  it("Cloud TTS marks: Bearer token, words from timepoints", async () => {
    const env = parseEnv({ GOOGLE_CLOUD_ACCESS_TOKEN: "ya29.token-abcdef", GOOGLE_CLOUD_PROJECT: "proj" });
    const ai = createGoogleAI(env, { rateLimiter: { acquire: () => Promise.resolve() }, logger: silent });
    http.on(
      "POST",
      "https://texttospeech.googleapis.com/v1beta1/text:synthesize",
      json({
        audioContent: pcmToWav(Buffer.alloc(48_000), 48_000).toString("base64"),
        timepoints: [
          { markName: "w0", timeSeconds: 0.02 },
          { markName: "w1", timeSeconds: 0.25 },
        ],
      }),
    );
    const res = await createGoogleProviders(env, ai).cloudTts.speak(
      { text: "Buy now", locale: "en-US", persona, pace: 1, style: "" },
      ctx("cloudtts"),
    );
    expect(http.calls[0]!.headers.get("authorization")).toBe("Bearer ya29.token-abcdef");
    expect(res.voice).toBe("en-US-Neural2-F");
    expect(res.words).toEqual([
      { text: "Buy", startMs: 20, endMs: 250 },
      { text: "now", startMs: 250, endMs: 500 },
    ]);
    expect(parseWav(fs.readFileSync(res.path))?.durationMs).toBe(500);
  });

  it("without keys the chain skips every Google provider, makes no request and falls back", async () => {
    const env = parseEnv({});
    const ai = createGoogleAI(env, { logger: silent });
    const google = createGoogleProviders(env, ai);
    const local: VoiceProvider = {
      name: "piper",
      capability: "voice",
      local: true,
      model: "piper/1",
      available: () => Promise.resolve({ ok: true }),
      supportsLocale: () => true,
      estimateMicros: () => 0,
      speak: () =>
        Promise.resolve({ path: "/tmp/x.wav", durationMs: 1, voice: "pl", characters: 1, cached: false }),
    };
    const tracker = new CostTracker();
    const out = await runChain<VoiceProvider, string>({
      capability: "voice",
      providers: [google.geminiTts, google.cloudTts, local],
      budget: new BudgetGate(1_000_000, tracker),
      estimate: () => 0,
      run: (p) => Promise.resolve(p.name),
    });
    expect(out.result).toBe("piper");
    expect(out.skipped.map((s) => s.provider)).toEqual(["gemini-tts", "cloud-tts-marks"]);
    expect(out.fallback?.wanted).toBe("gemini-tts");
    expect(http.calls).toHaveLength(0);
  });
});
