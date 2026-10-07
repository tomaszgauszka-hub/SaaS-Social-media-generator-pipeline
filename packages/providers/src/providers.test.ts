import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv, resolveModelCatalog } from "@cre/config";
import type * as Media from "@cre/media";
import { FatalError, ProviderError } from "@cre/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, stubFetch, text, type FetchStub } from "../../../test/fetch-stub.ts";
import { FalClient } from "./fal/client.ts";
import { FalBackgroundRemovalProvider, FalImageProvider, FalVideoProvider } from "./fal/providers.ts";
import { downloadToFile, requestJson, safeUrl } from "./http.ts";
import { S3StorageProvider } from "./storage/s3.ts";
import { charactersToWords, ElevenLabsTTSProvider, OpenAITTSProvider } from "./tts/remote.ts";
import type { ExecContext } from "./types.ts";

/**
 * Paid provider adapters against scripted HTTP replies (fal.ai queue API, OpenAI / ElevenLabs TTS, S3 presigning).
 * They prove request shape, polling, resume-without-resubmitting and error mapping — not that the live APIs still
 * behave this way (verify with a small budget before enabling; see docs/PROVIDERS.md).
 */
vi.mock("@cre/media", async (importOriginal) => ({
  ...(await importOriginal<typeof Media>()),
  // ffprobe is not part of the unit-test toolchain; the downloaded fixture is not a real media file anyway
  probeMedia: vi.fn(() =>
    Promise.resolve({
      durationMs: 5_000,
      sizeBytes: 4,
      hasVideo: true,
      hasAudio: true,
      width: 1080,
      height: 1920,
    }),
  ),
}));

const FAL = "https://queue.fal.run";
// built from defaults only (a developer .env with IMAGE_MODEL_* overrides must not change these tests)
const models = resolveModelCatalog(parseEnv({ MOCK_MEDIA: "false" }));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cre-providers-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function execCtx(over: Partial<ExecContext> = {}): ExecContext {
  return { workDir: fs.mkdtempSync(path.join(tmpRoot, "job-")), ...over };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

/** Script one fal queue request: submit → status sequence → result. */
function scriptFal(
  http: FetchStub,
  model: string,
  app: string,
  statuses: unknown[],
  output: unknown,
  id = "req-1",
) {
  const responseUrl = `${FAL}/${app}/requests/${id}`;
  http
    .on(
      "POST",
      `${FAL}/${model}`,
      json({ request_id: id, response_url: responseUrl, status_url: `${responseUrl}/status` }),
    )
    .on("GET", `${responseUrl}/status`, ...statuses.map((s) => json(s)))
    .on("GET", responseUrl, json(output));
  return responseUrl;
}

let http: FetchStub;
beforeEach(() => {
  http = stubFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ fal queue client -------------- */

describe("FalClient (queue API)", () => {
  const client = () => new FalClient({ apiKey: "fal-test-key", pollIntervalMs: 0 });

  it("submits, persists the request URL before polling, polls to completion and fetches the output", async () => {
    const responseUrl = scriptFal(
      http,
      "fal-ai/flux/schnell",
      "fal-ai/flux",
      [{ status: "IN_QUEUE" }, { status: "IN_PROGRESS" }, { status: "COMPLETED" }],
      { images: [] },
    );
    const persisted: { id: string; callsSoFar: number }[] = [];
    const res = await client().run(
      "fal-ai/flux/schnell",
      { prompt: "studio shot" },
      execCtx({
        onExternalJobId: (id) => {
          persisted.push({ id, callsSoFar: http.calls.length });
          return Promise.resolve();
        },
      }),
    );
    expect(res).toEqual({ output: { images: [] }, requestId: "req-1" });
    // persisted right after the (paid) submit and before the first status poll → a crash cannot double-charge
    expect(persisted).toEqual([{ id: responseUrl, callsSoFar: 1 }]);
    expect(http.calls.map((c) => c.method)).toEqual(["POST", "GET", "GET", "GET", "GET"]);
    expect(http.calls[0]!.headers.get("authorization")).toBe("Key fal-test-key");
    expect(JSON.parse(http.calls[0]!.body ?? "{}")).toEqual({ prompt: "studio shot" });
  });

  it("resumes a previous request instead of submitting (and paying) again", async () => {
    const responseUrl = scriptFal(
      http,
      "fal-ai/flux/schnell",
      "fal-ai/flux",
      [{ status: "COMPLETED" }],
      { ok: 1 },
      "req-9",
    );
    const res = await client().run(
      "fal-ai/flux/schnell",
      { prompt: "x" },
      execCtx({ externalJobId: responseUrl }),
    );
    expect(res.requestId).toBe("req-9");
    expect(http.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("fails without retry when the request errored (also when reported as COMPLETED) and counts it as charged", async () => {
    scriptFal(
      http,
      "fal-ai/flux/schnell",
      "fal-ai/flux",
      [{ status: "COMPLETED", error: "Internal model error" }],
      {},
    );
    const err = await rejection(client().run("fal-ai/flux/schnell", {}, execCtx()));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ retryable: false, charged: true });
    expect(http.calls).toHaveLength(2); // submit + one status poll, result never fetched
  });

  it("gives up retryably after the wait budget, keeping the request id for the next attempt", async () => {
    scriptFal(http, "fal-ai/flux/schnell", "fal-ai/flux", [{ status: "IN_PROGRESS" }], {});
    const slow = new FalClient({ apiKey: "k", pollIntervalMs: 5, maxWaitMs: 1 });
    const ids: string[] = [];
    const err = await rejection(
      slow.run(
        "fal-ai/flux/schnell",
        {},
        execCtx({
          onExternalJobId: (id) => {
            ids.push(id);
            return Promise.resolve();
          },
        }),
      ),
    );
    expect(err).toMatchObject({ retryable: true });
    expect(ids).toHaveLength(1);
  });

  it("maps HTTP failures: bad key is fatal, rate limit is retryable, no key never calls out", async () => {
    http.on(
      "POST",
      `${FAL}/fal-ai/flux/schnell`,
      json({ detail: "Invalid key" }, 401),
      json({ detail: "busy" }, 429),
    );
    expect(await rejection(client().run("fal-ai/flux/schnell", {}, execCtx()))).toMatchObject({
      status: 401,
      retryable: false,
    });
    expect(await rejection(client().run("fal-ai/flux/schnell", {}, execCtx()))).toMatchObject({
      status: 429,
      retryable: true,
    });
    const before = http.calls.length;
    await expect(
      new FalClient({ apiKey: undefined }).run("fal-ai/flux/schnell", {}, execCtx()),
    ).rejects.toBeInstanceOf(FatalError);
    expect(http.calls).toHaveLength(before);
  });
});

/* ------------------------------------------------------------------ fal media providers ----------- */

describe("fal media providers", () => {
  const client = () => new FalClient({ apiKey: "fal-test-key", pollIntervalMs: 0 });

  it("image: sends size, seed and the safety checker, downloads the result with provenance", async () => {
    scriptFal(http, models.image.cheap, "fal-ai/flux", [{ status: "COMPLETED" }], {
      images: [
        {
          url: "https://v3.fal.media/files/abc/out.jpg",
          width: 1080,
          height: 1920,
          content_type: "image/jpeg",
        },
      ],
      seed: 42,
      has_nsfw_concepts: [false],
    });
    http.on(
      "GET",
      "https://v3.fal.media/files/abc/out.jpg",
      new Response("JPEGDATA", { headers: { "content-length": "8" } }),
    );
    const provider = new FalImageProvider(client(), models);
    const res = await provider.execute(
      { prompt: "drill on a workbench", width: 1080, height: 1920, modelClass: "cheap", seed: 7 },
      execCtx(),
    );
    expect(fs.readFileSync(res.filePath, "utf8")).toBe("JPEGDATA");
    expect(res).toMatchObject({
      model: "fal-ai/flux/schnell",
      seed: 42,
      license: "generated:fal:fal-ai/flux/schnell",
      providerMeta: { sourceUrlHost: "v3.fal.media" },
    });
    expect(JSON.parse(http.calls[0]!.body ?? "{}")).toMatchObject({
      prompt: "drill on a workbench",
      image_size: { width: 1080, height: 1920 },
      enable_safety_checker: true,
      seed: 7,
    });
    // 1080×1920 → 3 MP (rounded up) × $0.003
    expect(
      provider.estimateCost({ prompt: "", width: 1080, height: 1920, modelClass: "cheap" }).estimatedMicros,
    ).toBe(9_000);
  });

  it("image: a safety-flagged result is rejected (charged, not retried) and never downloaded", async () => {
    scriptFal(http, models.image.cheap, "fal-ai/flux", [{ status: "COMPLETED" }], {
      images: [{ url: "https://v3.fal.media/files/abc/flagged.jpg" }],
      has_nsfw_concepts: [true],
    });
    const err = await rejection(
      new FalImageProvider(client(), models).execute(
        { prompt: "p", width: 1080, height: 1920, modelClass: "cheap" },
        execCtx(),
      ),
    );
    expect(err).toMatchObject({ retryable: false, charged: true });
    expect(http.callsTo("https://v3.fal.media/files/abc/flagged.jpg")).toHaveLength(0);
  });

  it("video: image-to-video request (5 s minimum, 9:16) with the local image inlined, priced as AI video", async () => {
    const model = models.video.cheap;
    scriptFal(http, model, "fal-ai/kling-video", [{ status: "COMPLETED" }], {
      video: { url: "https://v3.fal.media/files/v/out.mp4" },
    });
    http.on("GET", "https://v3.fal.media/files/v/out.mp4", new Response("MP4!"));
    const ctx = execCtx();
    const still = path.join(ctx.workDir, "still.png");
    fs.writeFileSync(still, "PNG");
    const provider = new FalVideoProvider(client(), models);
    const req = {
      imagePath: still,
      prompt: "slow push-in",
      durationSec: 4,
      width: 1080,
      height: 1920,
      fps: 30,
      modelClass: "cheap" as const,
    };
    const res = await provider.execute(req, ctx);
    expect(res).toMatchObject({ durationMs: 5_000, width: 1080, height: 1920, model });
    const body = JSON.parse(http.calls[0]!.body ?? "{}") as Record<string, string>;
    expect(body).toMatchObject({ duration: "5", aspect_ratio: "9:16", prompt: "slow push-in" });
    expect(body.image_url).toBe(`data:image/png;base64,${Buffer.from("PNG").toString("base64")}`);
    const estimate = provider.estimateCost(req);
    expect(estimate).toMatchObject({ isAiVideo: true, units: { videoSeconds: 5 }, estimatedMicros: 250_000 });
  });

  it("background removal: posts the image and stores a PNG cut-out", async () => {
    scriptFal(http, "fal-ai/birefnet", "fal-ai/birefnet", [{ status: "COMPLETED" }], {
      image: { url: "https://v3.fal.media/files/c/cut.png" },
    });
    http.on("GET", "https://v3.fal.media/files/c/cut.png", new Response("CUT"));
    const res = await new FalBackgroundRemovalProvider(client(), "fal-ai/birefnet").execute(
      { imagePath: "/unused.jpg", imageUrl: "https://shop.example.com/p.jpg" },
      execCtx(),
    );
    expect(res).toMatchObject({ mimeType: "image/png", license: "derived:background-removed" });
    expect(JSON.parse(http.calls[0]!.body ?? "{}")).toEqual({
      image_url: "https://shop.example.com/p.jpg",
      output_format: "png",
    });
  });
});

/* ------------------------------------------------------------------ HTTP helpers ------------------ */

describe("provider HTTP helpers", () => {
  it("never puts query strings (signatures, tokens) into error messages", async () => {
    http.on("GET", "https://api.example.com/x", text("nope", 500));
    const err = await rejection(
      requestJson("x", "https://api.example.com/x?token=SECRET", { method: "GET" }),
    );
    expect(err).toMatchObject({ status: 500, retryable: true });
    expect(String(err)).not.toContain("SECRET");
    expect(safeUrl("https://bucket.example.com/a/b.mp4?X-Amz-Signature=abc")).toBe(
      "https://bucket.example.com/a/b.mp4",
    );
  });

  it("enforces download size limits (declared and streamed)", async () => {
    http
      .on(
        "GET",
        "https://cdn.example.com/declared.mp4",
        new Response("0123456789", { headers: { "content-length": "10" } }),
      )
      .on("GET", "https://cdn.example.com/streamed.mp4", new Response("0123456789"))
      .on("GET", "https://cdn.example.com/missing.mp4", text("not found", 404));
    const dir = execCtx().workDir;
    expect(
      await rejection(
        downloadToFile("fal", "https://cdn.example.com/declared.mp4", path.join(dir, "a.mp4"), {
          maxBytes: 5,
        }),
      ),
    ).toMatchObject({ retryable: false });
    expect(
      await rejection(
        downloadToFile("fal", "https://cdn.example.com/streamed.mp4", path.join(dir, "b.mp4"), {
          maxBytes: 5,
        }),
      ),
    ).toMatchObject({ retryable: false });
    expect(fs.readdirSync(dir)).toEqual([]); // no truncated file or leftover temp file
    expect(
      await rejection(downloadToFile("fal", "https://cdn.example.com/missing.mp4", path.join(dir, "c.mp4"))),
    ).toMatchObject({ status: 404, retryable: false });
    await expect(
      downloadToFile("fal", "https://cdn.example.com/streamed.mp4", path.join(dir, "ok.mp4"), {
        maxBytes: 100,
      }),
    ).resolves.toMatchObject({ sizeBytes: 10 });
  });
});

/* ------------------------------------------------------------------ TTS --------------------------- */

describe("remote TTS providers", () => {
  it("OpenAI: posts the script and estimates word timings from the audio duration", async () => {
    http.on(
      "POST",
      "https://api.openai.com/v1/audio/speech",
      new Response("ID3audio", { headers: { "content-type": "audio/mpeg" } }),
    );
    const tts = new OpenAITTSProvider({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      model: "tts-1",
      defaultVoice: "nova",
    });
    const res = await tts.execute({ text: "Three drills worth it", language: "en" }, execCtx());
    expect(res).toMatchObject({ durationMs: 5_000, timingsExact: false, voice: "nova", characters: 21 });
    expect(res.words.map((w) => w.text)).toEqual(["Three", "drills", "worth", "it"]);
    expect(fs.readFileSync(res.filePath, "utf8")).toBe("ID3audio");
    expect(http.calls[0]!.headers.get("authorization")).toBe("Bearer sk-test");
    expect(JSON.parse(http.calls[0]!.body ?? "{}")).toMatchObject({
      model: "tts-1",
      voice: "nova",
      input: "Three drills worth it",
    });
    await expect(
      new OpenAITTSProvider({
        apiKey: undefined,
        baseUrl: "https://api.openai.com/v1",
        model: "tts-1",
      }).execute({ text: "x", language: "en" }, execCtx()),
    ).rejects.toBeInstanceOf(FatalError);
    expect(http.calls).toHaveLength(1);
  });

  it("ElevenLabs: uses character timestamps for exact word timings", async () => {
    const chars = [..."Hi there"];
    http.on(
      "POST",
      "https://api.elevenlabs.io/v1/text-to-speech/voice-1/with-timestamps",
      json({
        audio_base64: Buffer.from("MP3").toString("base64"),
        alignment: {
          characters: chars,
          character_start_times_seconds: chars.map((_, i) => i * 0.1),
          character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1),
        },
      }),
    );
    const tts = new ElevenLabsTTSProvider({
      apiKey: "xi-key",
      voiceId: "voice-1",
      model: "eleven_flash_v2_5",
    });
    const res = await tts.execute({ text: "Hi there", language: "en" }, execCtx());
    expect(res.timingsExact).toBe(true);
    expect(res.words).toEqual([
      { text: "Hi", startMs: 0, endMs: 200 },
      { text: "there", startMs: 300, endMs: 800 },
    ]);
    expect(http.calls[0]!.headers.get("xi-api-key")).toBe("xi-key");
    expect(http.calls[0]!.url.searchParams.get("output_format")).toBe("mp3_44100_128");
  });

  it("charactersToWords handles leading/trailing whitespace", () => {
    const chars = [..." ab  c "];
    expect(
      charactersToWords({
        characters: chars,
        character_start_times_seconds: chars.map((_, i) => i),
        character_end_times_seconds: chars.map((_, i) => i + 0.5),
      }),
    ).toEqual([
      { text: "ab", startMs: 1000, endMs: 2500 },
      { text: "c", startMs: 5000, endMs: 5500 },
    ]);
  });
});

/* ------------------------------------------------------------------ S3 / R2 ----------------------- */

describe("S3StorageProvider", () => {
  const s3 = (forcePathStyle: boolean) =>
    new S3StorageProvider({
      bucket: "cre-media",
      region: "auto",
      endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "very-secret-key",
      forcePathStyle,
      cacheDir: path.join(tmpRoot, "s3-cache"),
    });

  const signed = async (pathStyle: boolean, key: string, ttl: number) => {
    const url = await s3(pathStyle).getSignedUrl(key, ttl);
    if (!url) throw new Error("expected a signed URL");
    return new URL(url);
  };

  it("presigns time-limited GET URLs locally (no network) without exposing the secret", async () => {
    const url = await signed(true, "ws/w1/brand/b1/assets/a1.mp4", 600);
    expect(url.host).toBe("0123456789abcdef.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/cre-media/ws/w1/brand/b1/assets/a1.mp4");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.href).not.toContain("very-secret-key");
    const virtual = await signed(false, "ws/w1/a.mp4", 60);
    expect(virtual.host).toBe("cre-media.0123456789abcdef.r2.cloudflarestorage.com");
    expect(http.calls).toHaveLength(0);
  });

  it("rejects keys that could escape the bucket prefix", async () => {
    await expect(s3(true).getSignedUrl("../secrets.txt", 60)).rejects.toThrow(/Unsafe storage key/);
    await expect(s3(true).getSignedUrl("ws//double", 60)).rejects.toThrow(/Unsafe storage key/);
  });
});
