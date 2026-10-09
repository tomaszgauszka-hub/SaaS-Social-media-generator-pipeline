import { FatalError } from "@cre/shared";
import { assertModelId } from "./gemini.ts";

/*
 * Veo through `predictLongRunning` (a long-running operation), two surfaces:
 *
 *  - Agent Platform (Vertex) — the GA ids `veo-3.1-*-generate-001`:
 *      POST https://{loc}-aiplatform.googleapis.com/v1/projects/{p}/locations/{loc}/publishers/google/models/{m}:predictLongRunning
 *      poll POST …/models/{m}:fetchPredictOperation {operationName}
 *      done → response.videos[{bytesBase64Encoded | gcsUri, mimeType}] (inline when no storageUri is given)
 *      Supports generateAudio=false (cheaper video-only rate), seed, negativePrompt, resolution.
 *  - Gemini API — the `*-preview` ids (deprecated, shutdown 2026-10-22):
 *      POST {base}/v1beta/models/{m}:predictLongRunning, poll GET {base}/v1beta/{operation.name}
 *      done → response.generateVideoResponse.generatedSamples[{video:{uri}}], downloaded with the API key.
 *      Audio is always generated; no seed.
 *
 * Request: instances[{prompt, image?:{bytesBase64Encoded, mimeType}}], parameters {aspectRatio, durationSeconds
 * (4|6|8), resolution, negativePrompt, …}. Shapes from the Vertex Veo notebook / python-genai mapping (the
 * ai.google.dev pages could not be fetched from the build environment) — keep them here only.
 */

export type VideoSurface = "agent_platform" | "gemini_api";

export function videoSurface(model: string): VideoSurface {
  return /-preview$/.test(model) ? "gemini_api" : "agent_platform";
}

/** Veo generates 4, 6 or 8 s; shorter shots are generated at 4 s and trimmed by the caller. */
export const VEO_DURATIONS = [4, 6, 8] as const;

export function veoDurationSeconds(seconds: number): number {
  const s = Math.max(0, seconds);
  const pick = VEO_DURATIONS.find((d) => d >= s - 1e-9);
  if (pick === undefined) throw new FatalError(`Veo clips are at most 8 s (asked for ${seconds} s)`);
  return pick;
}

export function agentPlatformHost(location: string): string {
  return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}

export function agentPlatformModelUrl(
  project: string,
  location: string,
  model: string,
  method: string,
): string {
  return `https://${agentPlatformHost(location)}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${assertModelId(model)}:${method}`;
}

export function veoBody(
  surface: VideoSurface,
  req: {
    prompt: string;
    durationSeconds: number;
    aspectRatio: string;
    image?: { bytesBase64Encoded: string; mimeType: string } | undefined;
    negativePrompt?: string | undefined;
    resolution?: string | undefined;
    generateAudio?: boolean | undefined;
    seed?: number | undefined;
  },
): { instances: Record<string, unknown>[]; parameters: Record<string, unknown> } {
  const parameters: Record<string, unknown> = {
    aspectRatio: req.aspectRatio,
    durationSeconds: req.durationSeconds,
    ...(req.resolution ? { resolution: req.resolution } : {}),
    ...(req.negativePrompt ? { negativePrompt: req.negativePrompt } : {}),
  };
  if (surface === "agent_platform") {
    parameters.sampleCount = 1;
    parameters.generateAudio = req.generateAudio ?? false;
    if (req.seed !== undefined) parameters.seed = Math.floor(Math.abs(req.seed)) % 4_294_967_296;
  }
  return {
    instances: [{ prompt: req.prompt, ...(req.image ? { image: req.image } : {}) }],
    parameters,
  };
}

/** Operation names come back from storage on resume — accept only the shapes Google issues. */
export function assertOperationName(surface: VideoSurface, name: string): string {
  const ok =
    surface === "gemini_api"
      ? /^models\/[A-Za-z0-9._-]+\/operations\/[A-Za-z0-9._-]+$/.test(name)
      : /^projects\/[A-Za-z0-9._-]+\/locations\/[A-Za-z0-9-]+\/publishers\/google\/models\/[A-Za-z0-9._-]+\/operations\/[A-Za-z0-9._-]+$/.test(
          name,
        );
  if (!ok) throw new FatalError(`unexpected Veo operation name: ${JSON.stringify(name.slice(0, 120))}`);
  return name;
}

export interface VeoOperation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string; status?: string };
  response?: {
    /* Agent Platform */
    videos?: { bytesBase64Encoded?: string; gcsUri?: string; mimeType?: string }[];
    raiMediaFilteredCount?: number;
    raiMediaFilteredReasons?: string[];
    /* Gemini API */
    generateVideoResponse?: {
      generatedSamples?: { video?: { uri?: string; mimeType?: string } }[];
      raiMediaFilteredCount?: number;
      raiMediaFilteredReasons?: string[];
    };
  };
}

export type VeoResult =
  | { kind: "bytes"; data: Buffer; mimeType: string }
  | { kind: "uri"; uri: string; mimeType: string }
  | { kind: "gcs"; uri: string; mimeType: string }
  | { kind: "filtered"; reasons: string[] }
  | { kind: "empty" };

export function veoResult(op: VeoOperation): VeoResult {
  const r = op.response ?? {};
  const v = r.videos?.[0];
  if (v?.bytesBase64Encoded)
    return {
      kind: "bytes",
      data: Buffer.from(v.bytesBase64Encoded, "base64"),
      mimeType: v.mimeType ?? "video/mp4",
    };
  if (v?.gcsUri) return { kind: "gcs", uri: v.gcsUri, mimeType: v.mimeType ?? "video/mp4" };
  const sample = r.generateVideoResponse?.generatedSamples?.[0]?.video;
  if (sample?.uri) return { kind: "uri", uri: sample.uri, mimeType: sample.mimeType ?? "video/mp4" };
  const reasons = r.raiMediaFilteredReasons ?? r.generateVideoResponse?.raiMediaFilteredReasons ?? [];
  const filtered = r.raiMediaFilteredCount ?? r.generateVideoResponse?.raiMediaFilteredCount ?? 0;
  if (filtered > 0 || reasons.length) return { kind: "filtered", reasons };
  return { kind: "empty" };
}

/** gs://bucket/path → the JSON API media URL (Bearer-authenticated download). */
export function gcsMediaUrl(gcsUri: string): string {
  const m = /^gs:\/\/([a-z0-9._-]+)\/(.+)$/.exec(gcsUri);
  if (!m) throw new FatalError(`invalid GCS uri from Veo: ${gcsUri.slice(0, 120)}`);
  return `https://storage.googleapis.com/storage/v1/b/${m[1]}/o/${encodeURIComponent(m[2] ?? "")}?alt=media`;
}

/** Hosts the Gemini API key may be sent to when downloading a generated file. */
export function isGeminiApiHost(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).host === new URL(baseUrl).host;
  } catch {
    return false;
  }
}
