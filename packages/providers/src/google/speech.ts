import { FatalError } from "@cre/shared";
import type { RestContent, RestPart } from "./gemini.ts";
import type { TimedWord } from "./types.ts";

/*
 * Speech request shapes: Gemini TTS (generateContent with responseModalities ["AUDIO"]) and Cloud Text-to-Speech
 * v1beta1 `text:synthesize` with one SSML <mark> per word (the only Google TTS that reports timing). Field names
 * checked against the generativelanguage v1beta (rev 20261008) and texttospeech v1beta1 (rev 20260827) discovery
 * documents.
 */

/* ---------------------------------------------------------------- Gemini TTS ---------------------- */

/**
 * Gemini 2.5 / 3.1 preview TTS models take the older shape (prebuiltVoiceConfig.voiceName, style as a spoken
 * director's note in the text). Gemini 3.8+ speaks `text` verbatim and takes the style in Part.speechMetadata.
 */
export function isLegacyGeminiTts(model: string): boolean {
  return /^gemini-(2\.5|3\.1)-.*tts/.test(model);
}

export function geminiTtsBody(req: {
  model: string;
  text: string;
  voice: string;
  style?: string | undefined;
  languageCode: string;
}): { contents: RestContent[]; generationConfig: Record<string, unknown> } {
  const style = req.style?.trim();
  const legacy = isLegacyGeminiTts(req.model);
  const part: RestPart = legacy
    ? { text: style ? `Read the following in this style (${style}):\n${req.text}` : req.text }
    : { text: req.text, ...(style ? { speechMetadata: { style } } : {}) };
  return {
    contents: [{ role: "user", parts: [part] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: legacy ? { prebuiltVoiceConfig: { voiceName: req.voice } } : { voice: req.voice },
        languageCode: req.languageCode,
      },
    },
  };
}

/* ---------------------------------------------------------------- Cloud TTS + SSML marks ---------- */

/** Cloud TTS rejects SynthesisInput above 5 000 bytes. */
export const CLOUD_TTS_MAX_INPUT_BYTES = 5_000;

export function escapeSsml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function markName(index: number): string {
  return `w${index}`;
}

/** `<speak><mark name="w0"/>Kup <mark name="w1"/>teraz</speak>` for words [from, to). */
export function marksSsml(words: readonly string[], from = 0, to = words.length): string {
  const body = words
    .slice(from, to)
    .map((w, i) => `<mark name="${markName(from + i)}"/>${escapeSsml(w)}`)
    .join(" ");
  return `<speak>${body}</speak>`;
}

/**
 * Split the word list into SSML documents under the input limit (long voice-overs, multi-byte scripts). Every
 * chunk keeps the global mark indices so the timepoints map back to the original words.
 */
export function chunkMarksSsml(
  words: readonly string[],
  maxBytes = CLOUD_TTS_MAX_INPUT_BYTES,
): { from: number; to: number; ssml: string }[] {
  const chunks: { from: number; to: number; ssml: string }[] = [];
  let from = 0;
  while (from < words.length) {
    let to = from + 1;
    if (Buffer.byteLength(marksSsml(words, from, to)) > maxBytes) {
      throw new FatalError(`word ${from + 1} is too long for one Cloud TTS request`);
    }
    // grow while the document still fits (linear: voice-overs are a few hundred words at most)
    while (to < words.length && Buffer.byteLength(marksSsml(words, from, to + 1)) <= maxBytes) to++;
    chunks.push({ from, to, ssml: marksSsml(words, from, to) });
    from = to;
  }
  return chunks;
}

export function cloudTtsBody(req: {
  ssml: string;
  voiceName: string;
  languageCode: string;
  sampleRateHertz: number;
  speakingRate?: number | undefined;
}): Record<string, unknown> {
  return {
    input: { ssml: req.ssml },
    voice: { languageCode: req.languageCode, name: req.voiceName },
    audioConfig: {
      audioEncoding: "LINEAR16",
      sampleRateHertz: req.sampleRateHertz,
      ...(req.speakingRate !== undefined
        ? { speakingRate: Math.min(2, Math.max(0.25, Math.round(req.speakingRate * 100) / 100)) }
        : {}),
    },
    enableTimePointing: ["SSML_MARK"],
  };
}

export interface CloudTtsResponse {
  audioContent?: string;
  timepoints?: { markName?: string; timeSeconds?: number }[];
  audioConfig?: { sampleRateHertz?: number };
}

/**
 * Timepoints of words [from, to) → timed words. A word starts at its mark and ends where the next word starts;
 * the last word ends with the audio. Returns undefined when any mark is missing (the voice ignores <mark>, e.g.
 * Chirp 3 HD) — the caller must not invent timings.
 */
export function wordsFromTimepoints(
  words: readonly string[],
  from: number,
  to: number,
  timepoints: CloudTtsResponse["timepoints"],
  audioMs: number,
  offsetMs = 0,
): TimedWord[] | undefined {
  const at = new Map<string, number>();
  for (const tp of timepoints ?? []) {
    if (tp.markName && typeof tp.timeSeconds === "number" && Number.isFinite(tp.timeSeconds)) {
      at.set(tp.markName, Math.round(tp.timeSeconds * 1000));
    }
  }
  const starts: number[] = [];
  for (let i = from; i < to; i++) {
    const s = at.get(markName(i));
    if (s === undefined) return undefined;
    // marks are monotonic in practice; clamp so a jittery timepoint never yields a negative duration
    starts.push(Math.max(s, starts[starts.length - 1] ?? 0));
  }
  return starts.map((s, i) => {
    const next = starts[i + 1] ?? Math.max(audioMs, s);
    return { text: words[from + i] ?? "", startMs: offsetMs + s, endMs: offsetMs + Math.max(s, next) };
  });
}
