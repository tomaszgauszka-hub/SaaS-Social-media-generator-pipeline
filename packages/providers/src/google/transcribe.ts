import type { GenerateContentResponse, RestContent } from "./gemini.ts";
import { durationToMs } from "./media.ts";
import type { TimedWord } from "./types.ts";

/*
 * Word-timestamp transcription, two surfaces behind one `transcribe()`:
 *
 *  - Gemini transcription models (gemini-3.5-transcribe …) on the Gemini API: generateContent with
 *    generationConfig.audioTranscriptionConfig { wordTimestamp, languageCodes, mode: VERBATIM }; words come back in
 *    Part.audioTranscription.words[{word, startOffset, endOffset}] (discovery rev 20261008). Google marks word
 *    timestamps "experimental" and they cannot be combined with customVocabulary, so the known script is NOT sent.
 *  - Cloud Speech-to-Text v2 (chirp_3, chirp_2, long, short): synchronous Recognize with inline content
 *    (≤ 60 s, ≤ 10 MB), features.enableWordTimeOffsets; per-word startOffset/endOffset in the top alternative and
 *    metadata.totalBilledDuration for cost (discovery rev 20261001). chirp_3 is GA in the `us` / `eu` multi-regions.
 *
 * Neither is forced alignment: the recognised words may differ from the script — callers align them locally.
 */

export function geminiTranscribeBody(req: {
  audio: { mimeType: string; data: string };
  languageCode: string;
}): {
  contents: RestContent[];
  generationConfig: Record<string, unknown>;
} {
  return {
    contents: [{ role: "user", parts: [{ inlineData: req.audio }] }],
    generationConfig: {
      audioTranscriptionConfig: {
        wordTimestamp: true,
        languageCodes: [req.languageCode],
        mode: "VERBATIM",
      },
    },
  };
}

export function geminiTranscriptionWords(res: GenerateContentResponse): { words: TimedWord[]; text: string } {
  const words: TimedWord[] = [];
  const texts: string[] = [];
  for (const part of res.candidates?.[0]?.content?.parts ?? []) {
    const tr = part.audioTranscription;
    if (!tr) continue;
    if (tr.text) texts.push(tr.text);
    for (const w of tr.words ?? []) {
      const word = toTimedWord(w.word, w.startOffset, w.endOffset);
      if (word) words.push(word);
    }
  }
  if (!texts.length) {
    for (const part of res.candidates?.[0]?.content?.parts ?? []) {
      if (part.text && !part.thought) texts.push(part.text);
    }
  }
  return { words: sortWords(words), text: texts.join(" ").trim() };
}

/** Speech-to-Text v2 sync Recognize limits (inline content). */
export const STT_SYNC_MAX_BYTES = 10 * 1024 * 1024;
export const STT_SYNC_MAX_MS = 60_000;

export function sttRecognizeUrl(project: string, location: string): string {
  const host = location === "global" ? "speech.googleapis.com" : `${location}-speech.googleapis.com`;
  return `https://${host}/v2/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/recognizers/_:recognize`;
}

export function sttRecognizeBody(req: {
  model: string;
  languageCode: string;
  content: string;
}): Record<string, unknown> {
  return {
    config: {
      autoDecodingConfig: {},
      model: req.model,
      languageCodes: [req.languageCode],
      features: { enableWordTimeOffsets: true },
    },
    content: req.content,
  };
}

export interface SttRecognizeResponse {
  results?: {
    alternatives?: {
      transcript?: string;
      words?: { word?: string; startOffset?: unknown; endOffset?: unknown }[];
    }[];
    resultEndOffset?: unknown;
  }[];
  metadata?: { totalBilledDuration?: unknown };
}

export function sttWords(res: SttRecognizeResponse): {
  words: TimedWord[];
  text: string;
  billedSeconds?: number;
} {
  const words: TimedWord[] = [];
  const texts: string[] = [];
  for (const r of res.results ?? []) {
    const alt = r.alternatives?.[0];
    if (!alt) continue;
    if (alt.transcript) texts.push(alt.transcript.trim());
    for (const w of alt.words ?? []) {
      const word = toTimedWord(w.word, w.startOffset, w.endOffset);
      if (word) words.push(word);
    }
  }
  const billedMs = durationToMs(res.metadata?.totalBilledDuration);
  return {
    words: sortWords(words),
    text: texts.join(" ").trim(),
    ...(billedMs !== undefined ? { billedSeconds: billedMs / 1000 } : {}),
  };
}

function toTimedWord(word: unknown, start: unknown, end: unknown): TimedWord | undefined {
  if (typeof word !== "string" || !word.trim()) return undefined;
  const s = durationToMs(start ?? 0);
  if (s === undefined) return undefined;
  const e = durationToMs(end ?? start ?? 0) ?? s;
  return { text: word.trim(), startMs: Math.max(0, s), endMs: Math.max(s, e) };
}

function sortWords(words: TimedWord[]): TimedWord[] {
  return words.sort((a, b) => a.startMs - b.startMs);
}
