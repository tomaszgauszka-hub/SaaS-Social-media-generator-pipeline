import path from "node:path";
import { sha256Hex, stableStringify } from "@cre/shared";
import { runChain } from "../../capabilities/chain.ts";
import type {
  CallContext,
  TranscriptionProvider,
  VoiceProvider,
  VoiceRequest,
  VoiceResult,
} from "../../capabilities/types.ts";
import type { FallbackRecord } from "../../contracts/manifest.ts";
import type { VoiceTrack, WordTime } from "../../contracts/media.ts";
import type { LocaleCopy, ReelPlan } from "../../contracts/plan.ts";
import type { VoicePersona } from "../../contracts/profiles.ts";
import { BudgetGate, CostTracker } from "../../cost/tracker.ts";
import { decodeAudio, msToSamples, REEL_SR, writeWav16 } from "../pcm.ts";
import { fadeEdges, limit } from "../synth.ts";
import { alignWordsToPcm, detectSpeech, type SpeechRegion } from "./align.ts";
import { SPEECH_RMS_DB, speechRms } from "./process.ts";
import { wordTokens } from "./text.ts";

/**
 * Voice-over for one locale on the reel timeline:
 *
 *   each plan.voiceover segment (copy.slots[slot].text) → voice chain (the provider that voiced the first
 *   segment is tried first for the rest, so the reel keeps one voice) → speech onset / offset by VAD →
 *   placement: the first syllable on segment.atMs, segments in order with ≥ gapMs between them (later when
 *   the previous one is still talking), all speech inside plan.durationMs − endMarginMs (pulled earlier only
 *   when needed). Too long even so → every segment is re-synthesised faster (up to pace 1.15) → still too long
 *   → a VOICE_OVERFLOW issue (words are never cut by this module).
 *   Word timings: provider words → transcription chain (when its words match the script) → local alignment.
 *   Clips are levelled to −19 dBFS speech RMS and summed into ONE mono WAV of exactly plan.durationMs.
 */

export interface VoiceTrackIssue {
  code: "VOICE_OVERFLOW" | "VOICE_SLOT_MISSING" | "VOICE_SHIFTED" | "VOICE_PACE_RAISED";
  severity: "blocker" | "major" | "minor";
  message: string;
  slot?: string;
  atMs?: number;
}

export interface VoiceTrackResult extends VoiceTrack {
  issues: VoiceTrackIssue[];
  fallbacks: FallbackRecord[];
  /** pace the clips were finally synthesised at */
  pace: number;
}

export const VOICE_TRACK_VERSION = "voice-track/1";
export const MAX_FIT_PACE = 1.15;

/* ---------------------------------------------------------------- placement (pure) --------------- */

export interface PlacementItem {
  /** planned start of the speech (ms) */
  atMs: number;
  /** speech length (first to last syllable, ms) */
  speechMs: number;
}

/**
 * Speech start per segment: in order, never before the planned time unless that is the only way to stay inside
 * `limitMs`, with `gapMs` between segments. `overflowMs` > 0 when even back-to-back placement does not fit.
 */
export function placeSegments(
  items: readonly PlacementItem[],
  limitMs: number,
  gapMs: number,
): { startMs: number[]; overflowMs: number } {
  const s = items.map((it) => Math.max(0, Math.round(it.atMs)));
  const forward = () => {
    for (let i = 1; i < s.length; i++) s[i] = Math.max(s[i]!, s[i - 1]! + items[i - 1]!.speechMs + gapMs);
  };
  forward();
  const last = s.length - 1;
  const end = (i: number) => s[i]! + items[i]!.speechMs;
  if (last >= 0 && end(last) > limitMs) {
    let latest = limitMs;
    for (let i = last; i >= 0; i--) {
      s[i] = Math.max(0, Math.min(s[i]!, latest - items[i]!.speechMs));
      latest = s[i]! - gapMs;
    }
    forward();
  }
  return { startMs: s, overflowMs: last >= 0 ? Math.max(0, end(last) - limitMs) : 0 };
}

/* ---------------------------------------------------------------- helpers ------------------------- */

const TIMING_RANK: Record<VoiceTrack["timingsSource"], number> = {
  provider: 0,
  transcription: 1,
  alignment: 2,
  estimate: 3,
};

/** a provider wrapper that reports "locale not supported" through available() (keeps the chain's reasons) */
function forLocale(p: VoiceProvider, locale: string): VoiceProvider {
  return {
    name: p.name,
    capability: p.capability,
    local: p.local,
    model: p.model,
    available: () =>
      p.supportsLocale(locale)
        ? p.available()
        : Promise.resolve({ ok: false, reason: `no voice for ${locale}` }),
    supportsLocale: (l) => p.supportsLocale(l),
    estimateMicros: (r) => p.estimateMicros(r),
    speak: (r, c) => p.speak(r, c),
  };
}

interface Clip {
  slot: string;
  text: string;
  atMs: number;
  result: VoiceResult;
  provider: VoiceProvider;
  samples: Float32Array;
  regions: SpeechRegion[];
  /** first / last syllable inside the clip (ms) */
  speechStartMs: number;
  speechEndMs: number;
}

async function analyse(
  result: VoiceResult,
  signal?: AbortSignal,
): Promise<Pick<Clip, "samples" | "regions" | "speechStartMs" | "speechEndMs">> {
  const [samples] = await decodeAudio(result.path, { channels: 1, ...(signal ? { signal } : {}) });
  const regions = detectSpeech(samples!, REEL_SR);
  const durMs = Math.round((samples!.length * 1000) / REEL_SR);
  return {
    samples: samples!,
    regions,
    speechStartMs: regions[0]?.startMs ?? 0,
    speechEndMs: regions[regions.length - 1]?.endMs ?? durMs,
  };
}

/* ---------------------------------------------------------------- build --------------------------- */

export async function buildVoiceTrack(opts: {
  plan: ReelPlan;
  /** the locale copy to speak (default plan.copy) */
  copy?: LocaleCopy;
  persona: VoicePersona;
  voiceChain: readonly VoiceProvider[];
  transcriptionChain?: readonly TranscriptionProvider[];
  ctx: CallContext;
  /** the job's budget gate; default: free (local) providers only */
  budget?: BudgetGate;
  outPath?: string;
  gapMs?: number;
  endMarginMs?: number;
}): Promise<VoiceTrackResult> {
  const { plan, persona, ctx } = opts;
  const copy = opts.copy ?? plan.copy;
  const locale = copy.locale;
  const budget = opts.budget ?? new BudgetGate(0, new CostTracker());
  const gapMs = opts.gapMs ?? 160;
  const limitMs = plan.durationMs - (opts.endMarginMs ?? 150);
  const issues: VoiceTrackIssue[] = [];
  const fallbacks: FallbackRecord[] = [];
  const signal = ctx.signal;

  const segments = plan.voiceover.enabled
    ? plan.voiceover.segments.flatMap((seg) => {
        const text = copy.slots[seg.slot]?.text?.trim();
        if (text) return [{ slot: seg.slot, atMs: seg.atMs, text }];
        issues.push({
          code: "VOICE_SLOT_MISSING",
          severity: "major",
          message: `voice slot ${seg.slot} has no text in ${locale}`,
          slot: seg.slot,
          atMs: seg.atMs,
        });
        return [];
      })
    : [];

  const outPath =
    opts.outPath ??
    path.join(
      ctx.workDir,
      `voice-${locale}-${sha256Hex(stableStringify({ v: VOICE_TRACK_VERSION, plan: plan.metadata.planId, segments, d: plan.durationMs })).slice(0, 12)}.wav`,
    );
  const total = msToSamples(plan.durationMs);

  if (!segments.length) {
    await writeWav16(outPath, [new Float32Array(total)]);
    return {
      path: outPath,
      durationMs: plan.durationMs,
      words: [],
      timingsSource: "estimate",
      segments: [],
      provider: "none",
      model: "",
      voice: "",
      issues,
      fallbacks,
      pace: plan.voiceover.pace,
    };
  }

  let chain = opts.voiceChain.map((p) => forLocale(p, locale));
  const speak = async (text: string, pace: number, providers: readonly VoiceProvider[]) => {
    const req: VoiceRequest = { text, locale, persona, pace, style: plan.voiceover.style };
    const outcome = await runChain({
      capability: "voice",
      providers,
      budget,
      estimate: (p) => p.estimateMicros(req),
      run: (p) => p.speak(req, ctx),
      ...(signal ? { signal } : {}),
    });
    return outcome;
  };

  // 1. synthesise every segment (sticky provider)
  let pace = plan.voiceover.pace;
  const clips: Clip[] = [];
  for (const seg of segments) {
    const outcome = await speak(seg.text, pace, chain);
    if (outcome.fallback) fallbacks.push(outcome.fallback);
    const winner = outcome.provider;
    chain = [winner, ...chain.filter((p) => p.name !== winner.name)];
    clips.push({
      ...seg,
      result: outcome.result,
      provider: winner,
      ...(await analyse(outcome.result, signal)),
    });
  }

  // 2. placement; too long → faster re-synthesis (same provider) → placement again
  const items = () => clips.map((c) => ({ atMs: c.atMs, speechMs: c.speechEndMs - c.speechStartMs }));
  let placed = placeSegments(items(), limitMs, gapMs);
  const maxPace = Math.max(MAX_FIT_PACE, plan.voiceover.pace);
  if (placed.overflowMs > 0 && pace < maxPace - 0.005) {
    const speech = items().reduce((s, it) => s + it.speechMs, 0);
    const needed = speech / Math.max(1, speech - placed.overflowMs);
    const faster = Math.min(maxPace, Math.round(pace * needed * 1.03 * 100) / 100);
    if (faster > pace) {
      for (const [i, c] of clips.entries()) {
        try {
          const outcome = await speak(c.text, faster, [c.provider]);
          clips[i] = { ...c, result: outcome.result, ...(await analyse(outcome.result, signal)) };
        } catch (e) {
          ctx.logger?.warn(
            { slot: c.slot, err: e instanceof Error ? e.message : String(e) },
            "faster re-synthesis failed",
          );
        }
      }
      issues.push({
        code: "VOICE_PACE_RAISED",
        severity: "minor",
        message: `voice-over sped up from pace ${pace} to ${faster} to fit ${plan.durationMs} ms`,
      });
      pace = faster;
      placed = placeSegments(items(), limitMs, gapMs);
    }
  }
  if (placed.overflowMs > 0) {
    issues.push({
      code: "VOICE_OVERFLOW",
      severity: "major",
      message: `voice-over is ${placed.overflowMs} ms too long for the reel at pace ${pace} — shorten ${clips
        .map((c) => c.slot)
        .join(", ")}`,
      atMs: limitMs,
    });
  }
  clips.forEach((c, i) => {
    if (placed.startMs[i]! > c.atMs + 300)
      issues.push({
        code: "VOICE_SHIFTED",
        severity: "minor",
        message: `${c.slot} starts ${placed.startMs[i]! - c.atMs} ms after its planned time (previous line still speaking)`,
        slot: c.slot,
        atMs: placed.startMs[i]!,
      });
  });

  // 3. word timings per clip (relative to the clip start), best source first
  let worst: VoiceTrack["timingsSource"] = "provider";
  const clipWords: WordTime[][] = [];
  for (const c of clips) {
    const tokens = wordTokens(c.text);
    let words: WordTime[] | undefined;
    let source: VoiceTrack["timingsSource"] = "provider";
    if (c.result.words?.length) words = c.result.words;
    if (!words && opts.transcriptionChain?.length) {
      try {
        const t = await runChain({
          capability: "transcription",
          providers: opts.transcriptionChain,
          budget,
          estimate: (p) => p.estimateMicros(c.result.durationMs),
          run: (p) =>
            p.transcribe(
              { path: c.result.path, locale, expectedText: c.text, durationMs: c.result.durationMs },
              ctx,
            ),
          ...(signal ? { signal } : {}),
        });
        if (t.fallback) fallbacks.push(t.fallback);
        // only a word-for-word match is trusted (the script's spelling is what captions show)
        if (t.result.words.length === tokens.length) {
          words = t.result.words.map((w, k) => ({ text: tokens[k]!, startMs: w.startMs, endMs: w.endMs }));
          source = "transcription";
        }
      } catch (e) {
        ctx.logger?.debug({ err: e instanceof Error ? e.message : String(e) }, "transcription chain failed");
      }
    }
    if (!words) {
      const a = alignWordsToPcm(c.samples, REEL_SR, c.text, locale);
      words = a.words;
      source = a.timingsSource;
    }
    if (TIMING_RANK[source] > TIMING_RANK[worst]) worst = source;
    clipWords.push(words);
  }

  // 4. one mono track of exactly plan.durationMs
  const track = new Float32Array(total);
  const words: WordTime[] = [];
  const segOut: VoiceTrack["segments"] = [];
  clips.forEach((c, i) => {
    const speechStart = placed.startMs[i]!;
    const clipStartMs = speechStart - c.speechStartMs;
    const at = msToSamples(clipStartMs);
    const clip = Float32Array.from(c.samples);
    const rms = speechRms(clip, c.regions);
    const g = rms > 1e-6 ? Math.min(10 ** (12 / 20), 10 ** (SPEECH_RMS_DB / 20) / rms) : 1;
    fadeEdges(clip, 0.004 * REEL_SR, 0.004 * REEL_SR);
    for (let k = Math.max(0, -at); k < clip.length && at + k < total; k++) track[at + k]! += clip[k]! * g;
    for (const w of clipWords[i]!)
      words.push({
        text: w.text,
        startMs: Math.round(clipStartMs + w.startMs),
        endMs: Math.round(clipStartMs + w.endMs),
      });
    segOut.push({ slot: c.slot, startMs: speechStart, endMs: speechStart + c.speechEndMs - c.speechStartMs });
  });
  limit({ l: track, r: new Float32Array(total) }, 10 ** (-1.5 / 20), 3, 60);
  await writeWav16(outPath, [track]);

  // the provider that voiced most segments names the track
  const counts = new Map<string, Clip>();
  const tally = new Map<string, number>();
  for (const c of clips) {
    counts.set(c.provider.name, c);
    tally.set(c.provider.name, (tally.get(c.provider.name) ?? 0) + 1);
  }
  const main = counts.get([...tally].sort((a, b) => b[1] - a[1])[0]![0])!;
  return {
    path: outPath,
    durationMs: plan.durationMs,
    words: words.sort((a, b) => a.startMs - b.startMs),
    timingsSource: worst,
    segments: segOut,
    provider: main.provider.name,
    model: main.provider.model,
    voice: main.result.voice,
    issues,
    fallbacks,
    pace,
  };
}
