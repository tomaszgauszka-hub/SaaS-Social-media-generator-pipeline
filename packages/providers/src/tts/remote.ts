import fs from "node:fs";
import path from "node:path";
import { ttsCostMicros } from "@cre/config";
import { estimateWordTimings, probeMedia } from "@cre/media";
import { FatalError, ProviderError, sha256Hex } from "@cre/shared";
import { requestBinary, requestJson } from "../http.ts";
import type {
  CostEstimate,
  ExecContext,
  ProviderHealth,
  TTSProvider,
  TTSRequest,
  TTSResult,
  WordTiming,
} from "../types.ts";

/** OpenAI text-to-speech. No timestamps → word timings are estimated for captions. */
export class OpenAITTSProvider implements TTSProvider {
  readonly name = "openai";
  readonly kind = "tts" as const;
  readonly isMock = false;

  constructor(
    private readonly opts: {
      apiKey: string | undefined;
      baseUrl: string;
      model: string;
      defaultVoice?: string;
    },
  ) {}

  healthCheck(): Promise<ProviderHealth> {
    return Promise.resolve({
      ok: Boolean(this.opts.apiKey),
      provider: this.name,
      kind: "tts",
      isMock: false,
      message: this.opts.apiKey ? "OPENAI_API_KEY configured" : "OPENAI_API_KEY is not configured",
    });
  }

  estimateCost(req: TTSRequest): CostEstimate {
    return {
      provider: this.name,
      model: this.opts.model,
      operation: "TTS",
      estimatedMicros: ttsCostMicros("openai", this.opts.model, { characters: req.text.length }),
      units: { characters: req.text.length },
      isMock: false,
    };
  }

  async execute(req: TTSRequest, ctx: ExecContext): Promise<TTSResult> {
    if (!this.opts.apiKey) throw new FatalError("OPENAI_API_KEY is not configured");
    const voice = req.voice ?? this.opts.defaultVoice ?? "alloy";
    const { data } = await requestBinary(
      this.name,
      `${this.opts.baseUrl}/audio/speech`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.opts.model,
          input: req.text,
          voice,
          response_format: "mp3",
          speed: req.speed ?? 1,
        }),
      },
      { timeoutMs: 120_000, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    await fs.promises.mkdir(ctx.workDir, { recursive: true });
    const filePath = path.join(ctx.workDir, `tts-${sha256Hex(req.text).slice(0, 12)}.mp3`);
    await fs.promises.writeFile(filePath, data);
    const info = await probeMedia(filePath);
    return {
      filePath,
      mimeType: "audio/mpeg",
      model: this.opts.model,
      durationMs: info.durationMs,
      words: estimateWordTimings(req.text, info.durationMs),
      timingsExact: false,
      characters: req.text.length,
      voice,
      license: "generated:openai-tts (AI voice — disclose where required)",
    };
  }
}

interface ElevenLabsTimestampResponse {
  audio_base64: string;
  alignment?: {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
  };
}

/** Convert ElevenLabs character alignment to word timings (exact captions). */
export function charactersToWords(
  alignment: NonNullable<ElevenLabsTimestampResponse["alignment"]>,
): WordTiming[] {
  const words: WordTiming[] = [];
  let current = "";
  let start = 0;
  let end = 0;
  alignment.characters.forEach((ch, i) => {
    const s = alignment.character_start_times_seconds[i] ?? end;
    const e = alignment.character_end_times_seconds[i] ?? s;
    if (/\s/.test(ch)) {
      if (current)
        words.push({ text: current, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) });
      current = "";
      return;
    }
    if (!current) start = s;
    current += ch;
    end = e;
  });
  if (current)
    words.push({ text: current, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) });
  return words;
}

/** ElevenLabs TTS with character timestamps (accurate word-pop captions). */
export class ElevenLabsTTSProvider implements TTSProvider {
  readonly name = "elevenlabs";
  readonly kind = "tts" as const;
  readonly isMock = false;

  constructor(
    private readonly opts: { apiKey: string | undefined; voiceId: string | undefined; model: string },
  ) {}

  healthCheck(): Promise<ProviderHealth> {
    const ok = Boolean(this.opts.apiKey && this.opts.voiceId);
    return Promise.resolve({
      ok,
      provider: this.name,
      kind: "tts",
      isMock: false,
      message: ok ? "configured" : "ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are required",
    });
  }

  estimateCost(req: TTSRequest): CostEstimate {
    return {
      provider: this.name,
      model: this.opts.model,
      operation: "TTS",
      estimatedMicros: ttsCostMicros("elevenlabs", this.opts.model, { characters: req.text.length }),
      units: { characters: req.text.length },
      isMock: false,
    };
  }

  async execute(req: TTSRequest, ctx: ExecContext): Promise<TTSResult> {
    if (!this.opts.apiKey) throw new FatalError("ELEVENLABS_API_KEY is not configured");
    const voice = req.voice ?? this.opts.voiceId;
    if (!voice) throw new FatalError("ELEVENLABS_VOICE_ID is not configured");
    const res = await requestJson<ElevenLabsTimestampResponse>(
      this.name,
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": this.opts.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ text: req.text, model_id: this.opts.model }),
      },
      { timeoutMs: 120_000, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    if (!res.audio_base64)
      throw new ProviderError(this.name, "no audio in response", { retryable: true, charged: true });
    await fs.promises.mkdir(ctx.workDir, { recursive: true });
    const filePath = path.join(ctx.workDir, `tts-${sha256Hex(req.text).slice(0, 12)}.mp3`);
    await fs.promises.writeFile(filePath, Buffer.from(res.audio_base64, "base64"));
    const info = await probeMedia(filePath);
    const words = res.alignment
      ? charactersToWords(res.alignment)
      : estimateWordTimings(req.text, info.durationMs);
    return {
      filePath,
      mimeType: "audio/mpeg",
      model: this.opts.model,
      durationMs: info.durationMs,
      words,
      timingsExact: Boolean(res.alignment),
      characters: req.text.length,
      voice,
      license: "generated:elevenlabs (AI voice — disclose where required)",
    };
  }
}
