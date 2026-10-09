import { describe, expect, it } from "vitest";
import { cloudTtsBilledCharacters, cloudTtsFamily, isCloudSttModel, usageForCost } from "./cost.ts";
import { embedText, normalizeVector, usesTaskType } from "./embed.ts";
import { parseJsonText } from "./gemini.ts";
import {
  durationToMs,
  extensionForMime,
  imageDimensions,
  parseWav,
  pcmToWav,
  toWav,
  wavPcm,
} from "./media.ts";
import { chunkMarksSsml, escapeSsml, isLegacyGeminiTts, wordsFromTimepoints } from "./speech.ts";
import { retryDelayMs } from "./transport.ts";
import { assertOperationName, veoDurationSeconds, videoSurface } from "./video.ts";

/** Pure helpers of the Google client (no I/O). */
describe("media helpers", () => {
  it("parses WAV headers with extra chunks and exposes the PCM data", () => {
    const pcm = Buffer.alloc(48_000 * 2, 1);
    const plain = pcmToWav(pcm, 48_000);
    // insert a LIST chunk between fmt and data, as FFmpeg does
    const list = Buffer.concat([Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO")]);
    const withList = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
    withList.writeUInt32LE(withList.length - 8, 4);
    for (const wav of [plain, withList]) {
      const info = parseWav(wav)!;
      expect(info).toMatchObject({ sampleRate: 48_000, channels: 1, bitsPerSample: 16, durationMs: 1000 });
      expect(wavPcm(wav)!.pcm.equals(pcm)).toBe(true);
    }
    expect(parseWav(Buffer.from("not a wav"))).toBeUndefined();
  });

  it("wraps raw L16 PCM using the rate / channels from the MIME type", () => {
    const { wav, sampleRate } = toWav(Buffer.alloc(16_000 * 4), "audio/L16;codec=pcm;rate=16000;channels=2");
    expect(sampleRate).toBe(16_000);
    expect(parseWav(wav)).toMatchObject({ channels: 2, durationMs: 1000 });
  });

  it("reads JPEG dimensions from the SOF marker", () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x0a, 0xc0, 0x06, 0x00,
      0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    expect(imageDimensions(jpeg)).toEqual({ width: 1536, height: 2752 });
  });

  it("converts protobuf durations and MIME types", () => {
    expect(durationToMs("1.240s")).toBe(1240);
    expect(durationToMs({ seconds: "2", nanos: 500_000_000 })).toBe(2500);
    expect(durationToMs(0.25)).toBe(250);
    expect(durationToMs("soon")).toBeUndefined();
    expect(extensionForMime("audio/mpeg")).toBe(".mp3");
    expect(extensionForMime("image/jpeg")).toBe(".jpg");
    expect(extensionForMime("application/x-unknown")).toBe(".bin");
  });
});

describe("transport helpers", () => {
  it("Retry-After as seconds or HTTP date, else RetryInfo, else undefined", () => {
    const now = Date.parse("2026-10-09T10:00:00Z");
    expect(retryDelayMs("3", undefined, now)).toBe(3000);
    expect(retryDelayMs("Fri, 09 Oct 2026 10:00:05 GMT", undefined, now)).toBe(5000);
    expect(
      retryDelayMs(
        null,
        { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1.5s" }] },
        now,
      ),
    ).toBe(1500);
    expect(retryDelayMs(null, undefined, now)).toBeUndefined();
  });

  it("tolerates a fenced JSON answer", () => {
    expect(parseJsonText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseJsonText("{oops")).toThrow();
  });
});

describe("speech helpers", () => {
  it("escapes SSML and keeps global mark indices across chunks", () => {
    expect(escapeSsml(`a&b<c>"d'`)).toBe("a&amp;b&lt;c&gt;&quot;d&apos;");
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`);
    const chunks = chunkMarksSsml(words, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.from).toBe(0);
    expect(chunks[chunks.length - 1]!.to).toBe(30);
    for (const c of chunks) expect(Buffer.byteLength(c.ssml)).toBeLessThanOrEqual(200);
    expect(chunks[1]!.ssml).toContain(`<mark name="w${chunks[1]!.from}"/>`);
  });

  it("returns undefined when a mark is missing; clamps non-monotonic marks", () => {
    expect(wordsFromTimepoints(["a", "b"], 0, 2, [{ markName: "w0", timeSeconds: 0 }], 500)).toBeUndefined();
    expect(
      wordsFromTimepoints(
        ["a", "b"],
        0,
        2,
        [
          { markName: "w0", timeSeconds: 0.2 },
          { markName: "w1", timeSeconds: 0.1 },
        ],
        500,
      ),
    ).toEqual([
      { text: "a", startMs: 200, endMs: 200 },
      { text: "b", startMs: 200, endMs: 500 },
    ]);
  });

  it("detects the legacy Gemini TTS request shape", () => {
    expect(isLegacyGeminiTts("gemini-2.5-flash-preview-tts")).toBe(true);
    expect(isLegacyGeminiTts("gemini-3.1-flash-tts-preview")).toBe(true);
    expect(isLegacyGeminiTts("gemini-3.8-flash-tts")).toBe(false);
  });
});

describe("cost mapping", () => {
  it("maps Cloud TTS voice names to price families", () => {
    expect(cloudTtsFamily("pl-PL-Wavenet-A")).toBe("cloudtts-wavenet");
    expect(cloudTtsFamily("en-US-Neural2-F")).toBe("cloudtts-neural2");
    expect(cloudTtsFamily("en-US-Chirp3-HD-Aoede")).toBe("cloudtts-chirp3-hd");
    expect(cloudTtsFamily("en-US-Casual-K")).toBe("cloudtts-studio"); // unknown family → most expensive
    expect(cloudTtsFamily("gemini-3.8-flash-tts")).toBeUndefined();
    expect(cloudTtsBilledCharacters('<speak><mark name="w0"/>Hi</speak>')).toBe("<speak>Hi</speak>".length);
  });

  it("splits usage by modality; unsplit tokens go to the pessimistic bucket; thinking is output", () => {
    expect(
      usageForCost({
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 30,
        cachedContentTokenCount: 10,
        promptTokensDetails: [{ modality: "IMAGE", tokenCount: 60 }],
        candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 50 }],
      }),
    ).toEqual({
      input: { image: 60 },
      inputUnspecified: 40,
      cachedInput: 10,
      output: { audio: 50 },
      outputUnspecified: 0,
      thoughts: 30,
    });
  });

  it("routes transcription models to the right surface", () => {
    expect(isCloudSttModel("chirp_3")).toBe(true);
    expect(isCloudSttModel("long")).toBe(true);
    expect(isCloudSttModel("gemini-3.5-transcribe")).toBe(false);
  });
});

describe("embedding helpers", () => {
  it("uses task prefixes for gemini-embedding-2 and task types for 001", () => {
    expect(embedText("lamp", "query", "gemini-embedding-2")).toBe("task: search result | query: lamp");
    expect(embedText("lamp", "document", "gemini-embedding-2")).toBe("title: none | text: lamp");
    expect(usesTaskType("gemini-embedding-001")).toBe(true);
    expect(embedText("lamp", "query", "gemini-embedding-001")).toBe("lamp");
    expect(normalizeVector([3, 4, 12], 2)).toEqual([0.6, 0.8]);
  });
});

describe("Veo helpers", () => {
  it("rounds to the billed 4 / 6 / 8 s and picks the surface from the model id", () => {
    expect(veoDurationSeconds(1)).toBe(4);
    expect(veoDurationSeconds(4)).toBe(4);
    expect(veoDurationSeconds(5)).toBe(6);
    expect(veoDurationSeconds(8)).toBe(8);
    expect(() => veoDurationSeconds(9)).toThrow(/at most 8/);
    expect(videoSurface("veo-3.1-fast-generate-001")).toBe("agent_platform");
    expect(videoSurface("veo-3.1-lite-generate-preview")).toBe("gemini_api");
  });

  it("accepts only operation names shaped like Google's", () => {
    expect(
      assertOperationName("gemini_api", "models/veo-3.1-fast-generate-preview/operations/abc"),
    ).toBeTruthy();
    expect(() => assertOperationName("gemini_api", "../../files/x")).toThrow();
    expect(() => assertOperationName("agent_platform", "models/veo/operations/abc")).toThrow();
  });
});
