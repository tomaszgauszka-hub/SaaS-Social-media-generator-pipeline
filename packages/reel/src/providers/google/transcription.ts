import type { Env } from "@cre/config";
import { isCloudSttModel, type GoogleAI } from "@cre/providers";
import type { CallContext, TranscriptionProvider } from "../../capabilities/types.ts";
import type { LocaleTag } from "../../contracts/ids.ts";
import type { WordTime } from "../../contracts/media.ts";
import { cacheKey, fileSha256 } from "../../util/cache.ts";
import { cachedCall, paid, recordCall } from "./common.ts";

/*
 * Word timestamps for a voice clip (Gemini transcription model on the Gemini API, or Speech-to-Text v2 chirp_3
 * when GOOGLE_TRANSCRIPTION_MODEL names a Cloud STT model). This is ASR, not forced alignment: the recognised
 * words can differ from the script. `exact` is true only when the recognised words match the expected script
 * token for token, so the caller knows whether it can use them directly or must align them locally.
 */

export const TRANSCRIPTION_VERSION = "google-transcription/1";
const NS = "google.transcription";

/** lower-case letters and digits only — punctuation / casing differences do not count as mismatches */
export function normalizedTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter(Boolean);
}

export function matchesScript(words: readonly WordTime[], expectedText: string): boolean {
  const got = normalizedTokens(words.map((w) => w.text).join(" "));
  const want = normalizedTokens(expectedText);
  return got.length === want.length && got.every((t, i) => t === want[i]);
}

interface TranscriptMeta {
  words: WordTime[];
  text: string;
}

export class GoogleTranscriptionProvider implements TranscriptionProvider {
  readonly name = "google-transcription";
  readonly capability = "transcription" as const;
  readonly local = false;
  readonly model: string;

  constructor(
    env: Pick<Env, "GOOGLE_TRANSCRIPTION_MODEL">,
    private readonly ai: GoogleAI,
  ) {
    this.model = env.GOOGLE_TRANSCRIPTION_MODEL;
  }

  available(): Promise<{ ok: boolean; reason?: string }> {
    if (isCloudSttModel(this.model)) {
      if (!this.ai.hasCloudToken)
        return Promise.resolve({ ok: false, reason: "GOOGLE_CLOUD_ACCESS_TOKEN is not configured" });
      if (!this.ai.hasCloudProject)
        return Promise.resolve({ ok: false, reason: "GOOGLE_CLOUD_PROJECT is not configured" });
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve(
      this.ai.hasApiKey ? { ok: true } : { ok: false, reason: "GOOGLE_API_KEY is not configured" },
    );
  }

  estimateMicros(audioMs: number): number {
    return this.ai.estimateTranscriptionMicros(this.model, audioMs);
  }

  async transcribe(
    req: { path: string; locale: LocaleTag; expectedText?: string; durationMs: number },
    ctx: CallContext,
  ): Promise<{ words: WordTime[]; exact: boolean }> {
    const audioSha = await fileSha256(req.path);
    const key = cacheKey(NS, TRANSCRIPTION_VERSION, { model: this.model, audioSha, locale: req.locale });
    const res = await cachedCall<TranscriptMeta>({
      ctx,
      namespace: NS,
      key,
      required: [],
      capability: "transcription",
      model: this.model,
      hitUnits: { audioSeconds: req.durationMs / 1000 },
      produce: async () => {
        const out = await paid(ctx, "transcription", this.model, () =>
          this.ai.transcribe({
            model: this.model,
            audioPath: req.path,
            languageCode: req.locale,
            durationMs: req.durationMs,
            label: "reel.captions",
            ...(req.expectedText ? { expectedText: req.expectedText } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
        );
        recordCall(ctx, {
          capability: "transcription",
          model: this.model,
          costMicros: out.costMicros,
          estimated: out.costEstimated,
          usage: out.usage,
          units: { audioSeconds: req.durationMs / 1000 },
          latencyMs: out.latencyMs,
        });
        return { words: out.words, text: out.text };
      },
    });
    const exact = req.expectedText === undefined || matchesScript(res.meta.words, req.expectedText);
    return { words: res.meta.words, exact };
  }
}
