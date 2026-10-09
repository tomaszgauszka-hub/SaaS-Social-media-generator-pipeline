import { sha256Hex, stableStringify } from "@cre/shared";
import type { MusicIntent } from "../../contracts/plan.ts";
import { prng, SR } from "../synth.ts";
import {
  charVelocity,
  GENRE_STYLES,
  MOOD_HARMONY,
  type Chord,
  type GenreStyle,
  type MoodHarmony,
} from "./styles.ts";

/**
 * The local composer's arranger: MusicIntent → a list of timed notes (pure, no audio). BPM-locked 16th grid
 * from sample 0, harmony from the mood, instrumentation and patterns from the genre, layer density following
 * the energy curve, and the plan's accents:
 *
 *   riser      builds from its time to the next drop / final hit / stop (≤ 8 bars; 1 bar when none follows)
 *   drop       full groove; crash + sub boom on the downbeat, energy lifted for 2 bars
 *   final_hit  the groove stops, one big hit (kick, boom, crash, full chord) lands EXACTLY on timeMs, tails ring
 *   stop       everything stops at timeMs
 *
 * Before a drop / final hit the groove leaves a 1/8-note "air" gap (only the riser and its roll keep going).
 */

export type Bus = "drums" | "bass" | "harmony" | "pad" | "top" | "fx" | "hit" | "texture";

export interface ArrangedNote {
  /** onset (samples from the start) */
  at: number;
  inst: string;
  /** MIDI pitches (empty for unpitched percussion) */
  midi: number[];
  /** gate length (s) */
  lenS: number;
  /** linear gain (velocity × lane level) */
  vel: number;
  pan: number;
  bus: Bus;
  /** reverb send 0..1 */
  send: number;
  /** strum direction / round-robin variant */
  variant: number;
}

export interface ResolvedEvents {
  drops: number[];
  risers: { startMs: number; endMs: number }[];
  finalHitMs?: number;
  stopMs?: number;
  /** groove notes start before this time (ms) */
  grooveEndMs: number;
}

export interface Arrangement {
  intent: MusicIntent;
  style: GenreStyle;
  harmony: MoodHarmony;
  samples: number;
  bpm: number;
  stepSamples: number;
  beatSamples: number;
  barSamples: number;
  tonic: number;
  progression: readonly Chord[];
  voicings: number[][];
  events: ResolvedEvents;
  notes: ArrangedNote[];
  /** kick onsets (samples) — sidechain triggers */
  kicks: number[];
  /** effective energy per ms */
  energyAt: (tMs: number) => number;
  seed: number;
}

/** uint32 seed of an intent (everything that shapes the music) */
export function intentSeed(intent: MusicIntent): number {
  return parseInt(
    sha256Hex(stableStringify({ s: intent.seed, g: intent.genre, m: intent.mood, b: intent.bpm })).slice(
      0,
      8,
    ),
    16,
  );
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function barMsOf(bpm: number): number {
  return (4 * 60_000) / bpm;
}

export function resolveEvents(intent: MusicIntent): ResolvedEvents {
  const D = intent.durationMs;
  const beat = 60_000 / intent.bpm;
  const bar = 4 * beat;
  const sorted = [...intent.events].sort((a, b) => a.timeMs - b.timeMs);
  const stopMs = sorted.find((e) => e.event === "stop" && e.timeMs > 0 && e.timeMs < D)?.timeMs;
  const limit = stopMs ?? D;
  const finalHitMs = sorted.find((e) => e.event === "final_hit" && e.timeMs > 0 && e.timeMs < limit)?.timeMs;
  const grooveEndMs = Math.min(limit, finalHitMs ?? D);
  const drops = sorted
    .filter((e) => e.event === "drop" && e.timeMs > 0 && e.timeMs < grooveEndMs)
    .map((e) => e.timeMs);
  const targets = [
    ...drops,
    ...(finalHitMs !== undefined ? [finalHitMs] : []),
    ...(stopMs !== undefined ? [stopMs] : []),
  ];
  const risers: ResolvedEvents["risers"] = [];
  for (const e of sorted) {
    if (e.event !== "riser" || e.timeMs >= grooveEndMs) continue;
    const next = targets
      .filter((t) => t > e.timeMs + beat / 2 && t - e.timeMs <= 8 * bar)
      .sort((a, b) => a - b)[0];
    const endMs = Math.min(next ?? e.timeMs + bar, D);
    if (endMs - e.timeMs >= beat / 2) risers.push({ startMs: e.timeMs, endMs });
  }
  return {
    drops,
    risers,
    ...(finalHitMs !== undefined ? { finalHitMs } : {}),
    ...(stopMs !== undefined ? { stopMs } : {}),
    grooveEndMs,
  };
}

/**
 * Effective energy over time: the intent's energy points interpolated linearly (held before the first and after
 * the last; constant `intent.energy` when there are none), lifted towards 0.92 right after each drop and
 * decaying back to the curve over 2 bars.
 */
export function energyFunction(intent: MusicIntent): (tMs: number) => number {
  const pts = intent.events
    .filter((e) => e.energy !== undefined)
    .map((e) => ({ t: e.timeMs, e: clamp01(e.energy!) }))
    .sort((a, b) => a.t - b.t);
  const drops = resolveEvents(intent).drops;
  const lift = 2 * barMsOf(intent.bpm);
  const base = (t: number): number => {
    if (!pts.length) return clamp01(intent.energy);
    if (t <= pts[0]!.t) return pts[0]!.e;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if (t <= b.t) return b.t === a.t ? b.e : a.e + ((b.e - a.e) * (t - a.t)) / (b.t - a.t);
    }
    return pts[pts.length - 1]!.e;
  };
  return (t: number) => {
    const e = base(t);
    let boost = 0;
    for (const d of drops) if (t >= d && t < d + lift) boost = Math.max(boost, 1 - (t - d) / lift);
    return boost > 0 ? e + (Math.max(e, 0.92) - e) * boost : e;
  };
}

/** gain of a layer at energy e: silent below its threshold, 0.7 … 1 over the next 0.2 */
export function layerGain(e: number, minEnergy: number): number {
  if (e < minEnergy) return 0;
  return 0.7 + 0.3 * Math.min(1, (e - minEnergy) / 0.2);
}

/* ------------------------------------------------------------------ harmony ---------------------- */

/** close voicings with minimal movement between consecutive chords (lowest voice in [53, 65)) */
export function voiceLead(tonic: number, progression: readonly Chord[]): number[][] {
  const out: number[][] = [];
  let prev: number[] | null = null;
  for (const chord of progression) {
    const pcs = [...new Set(chord.tones.map((t) => (((tonic + chord.root + t) % 12) + 12) % 12))];
    let best: number[] = [];
    let bestCost = Infinity;
    for (let inv = 0; inv < pcs.length; inv++) {
      const order = [...pcs.slice(inv), ...pcs.slice(0, inv)];
      for (let base = 53; base < 65; base++) {
        if (base % 12 !== order[0]) continue;
        const v: number[] = [base];
        for (const pc of order.slice(1)) {
          let n = v[v.length - 1]! + 1;
          while (n % 12 !== pc) n++;
          v.push(n);
        }
        const cost = prev
          ? v.reduce((s, n, i) => s + Math.abs(n - (prev![Math.min(i, prev!.length - 1)] ?? n)), 0)
          : Math.abs(v[0]! - 57) + Math.abs(v[v.length - 1]! - 69) * 0.5;
        if (cost < bestCost) {
          bestCost = cost;
          best = v;
        }
      }
    }
    out.push(best);
    prev = best;
  }
  return out;
}

/** chord root in the bass register [33, 45] */
export function bassNote(tonic: number, chord: Chord): number {
  let n = tonic + chord.root;
  while (n > 45) n -= 12;
  while (n < 33) n += 12;
  return n;
}

/* ------------------------------------------------------------------ arrangement ------------------- */

interface PatternHit {
  step: number;
  ch: string;
  /** steps until the next onset in the pattern (ties included) */
  lenSteps: number;
}

/** expand a pattern over [0, steps): onsets with their lengths (ties extend, rests end a note) */
function patternHits(pattern: string, steps: number): PatternHit[] {
  const hits: PatternHit[] = [];
  for (let k = 0; k < steps; k++) {
    const ch = pattern[k % pattern.length]!;
    if (ch === "." || ch === "-") continue;
    let len = 1;
    while (k + len < steps && pattern[(k + len) % pattern.length] === "-") len++;
    hits.push({ step: k, ch, lenSteps: len });
  }
  return hits;
}

export function arrange(intent: MusicIntent): Arrangement {
  const style = GENRE_STYLES[intent.genre];
  const harmony = MOOD_HARMONY[intent.mood];
  const seed = intentSeed(intent);
  const rand = prng(seed);
  const samples = Math.round((intent.durationMs * SR) / 1000);
  const bpm = intent.bpm;
  const stepSamples = (SR * 60) / bpm / 4;
  const beatSamples = stepSamples * 4;
  const barSamples = stepSamples * 16;
  const steps = Math.ceil(samples / stepSamples);
  const events = resolveEvents(intent);
  const energyAt = energyFunction(intent);
  const swing = Math.min(0.3, style.swing + harmony.swing);
  const toS = (ms: number) => Math.round((ms * SR) / 1000);
  const grooveEnd = toS(events.grooveEndMs);
  const progression = harmony.progressions[Math.floor(rand() * harmony.progressions.length)]!;
  const tonic = harmony.tonics[Math.floor(rand() * harmony.tonics.length)]!;
  const voicings = voiceLead(tonic, progression);
  const onset = (k: number) => Math.round(k * stepSamples + (k % 2 === 1 ? swing * stepSamples : 0));
  const stepS = stepSamples / SR;
  const chordIdx = (step: number) =>
    Math.floor(Math.floor(step / 16) / harmony.barsPerChord) % progression.length;
  const accents = [...events.drops, ...(events.finalHitMs !== undefined ? [events.finalHitMs] : [])].map(toS);
  /** inside the 1/8-note air gap before a drop / final hit */
  const inAir = (at: number) => accents.some((a) => at >= a - 2 * stepSamples - 1 && at < a);
  const eAt = (at: number) => clamp01(energyAt((at * 1000) / SR) + harmony.energyBias);
  const notes: ArrangedNote[] = [];
  const kicks: number[] = [];
  const db = (g: number) => 10 ** (g / 20);
  const lenTo = (at: number, lenS: number) => Math.max(0.02, Math.min(lenS, (grooveEnd - at) / SR));

  // drums
  style.drums.forEach((lane, li) => {
    for (const h of patternHits(lane.pattern, steps)) {
      const at = onset(h.step);
      if (at >= grooveEnd || inAir(at)) continue;
      const g = layerGain(eAt(at), lane.minEnergy);
      if (!g) continue;
      const human = h.ch === "X" ? 1 : 0.93 + 0.07 * rand();
      notes.push({
        at,
        inst: lane.inst,
        midi: [],
        lenS: stepS,
        vel: charVelocity(h.ch) * db(lane.gainDb) * g * human,
        pan: lane.pan ?? 0,
        bus: "drums",
        send: lane.send ?? 0.05,
        variant: (h.step + li) % 3,
      });
      if (
        lane.inst === "kick" ||
        lane.inst === "kick_soft" ||
        lane.inst === "kick_hard" ||
        lane.inst === "taiko"
      )
        kicks.push(at);
    }
  });

  // bass
  for (const h of patternHits(style.bass.pattern, steps)) {
    const at = onset(h.step);
    if (at >= grooveEnd || inAir(at)) continue;
    const g = layerGain(eAt(at), style.bass.minEnergy);
    if (!g) continue;
    const root = bassNote(tonic, progression[chordIdx(h.step)]!) + 12 * style.bass.octave;
    const midi = h.ch === "O" ? root + 12 : h.ch === "5" ? root + 7 : root;
    // a held bass note never crosses a chord change
    const toChange = 16 * harmony.barsPerChord - (h.step % (16 * harmony.barsPerChord));
    notes.push({
      at,
      inst: style.bass.inst,
      midi: [midi],
      lenS: lenTo(at, Math.min(h.lenSteps, toChange) * stepS * 0.92),
      vel: charVelocity(h.ch) * db(style.bass.gainDb) * g,
      pan: 0,
      bus: "bass",
      send: 0,
      variant: 0,
    });
  }

  // harmony (rhythmic or held) + optional sustained pad
  const slotSteps = 16 * harmony.barsPerChord;
  const holdLayer = (inst: string, gainDb: number, minEnergy: number, send: number, bus: Bus) => {
    for (let k = 0; k < steps; k += slotSteps) {
      const at = onset(k);
      if (at >= grooveEnd) continue;
      const g = layerGain(eAt(at), minEnergy);
      if (!g) continue;
      notes.push({
        at,
        inst,
        midi: voicings[chordIdx(k)]!,
        lenS: lenTo(at, slotSteps * stepS * 0.98),
        vel: db(gainDb) * g,
        pan: 0,
        bus,
        send,
        variant: 0,
      });
    }
  };
  const hm = style.harmony;
  if (hm.pattern === "hold") holdLayer(hm.inst, hm.gainDb, hm.minEnergy, hm.send, "harmony");
  else {
    for (const h of patternHits(hm.pattern, steps)) {
      const at = onset(h.step);
      if (at >= grooveEnd || inAir(at)) continue;
      const g = layerGain(eAt(at), hm.minEnergy);
      if (!g) continue;
      const lenSteps = h.ch === "m" ? 1 : h.lenSteps * harmony.legato;
      notes.push({
        at,
        inst: h.ch === "m" ? "guitar_chop" : hm.inst,
        midi: voicings[chordIdx(h.step)]!,
        lenS: lenTo(at, Math.max(1, lenSteps) * stepS),
        vel: charVelocity(h.ch) * db(hm.gainDb) * g,
        pan: hm.inst === "guitar" ? -0.2 : 0,
        bus: "harmony",
        send: hm.send,
        variant: h.ch === "U" ? 1 : 0,
      });
    }
  }
  if (style.pad) holdLayer(style.pad.inst, style.pad.gainDb, style.pad.minEnergy, style.pad.send, "pad");

  // top line: arpeggio / motif / chord stabs / ostinato pulse
  if (style.top) {
    const top = style.top;
    const motif = Array.from({ length: 8 }, () => Math.floor(rand() * 4));
    let idx = 0;
    let lastSlot = -1;
    for (const h of patternHits(top.pattern, steps)) {
      const at = onset(h.step);
      if (at >= grooveEnd || inAir(at)) continue;
      const g = layerGain(eAt(at), top.minEnergy);
      if (!g) continue;
      const slot = Math.floor(h.step / slotSteps);
      if (slot !== lastSlot) {
        idx = 0;
        lastSlot = slot;
      }
      const v = voicings[chordIdx(h.step)]!;
      const up = 12 * top.octave;
      let midi: number[];
      switch (top.mode) {
        case "chord":
          midi = v.map((n) => n + up);
          break;
        case "pulse": {
          const root = bassNote(tonic, progression[chordIdx(h.step)]!) + 12;
          midi = [root + up, root + 7 + up];
          break;
        }
        case "arp_up":
          midi = [v[idx % v.length]! + up];
          break;
        case "arp_updown": {
          const cycle = [...v, ...v.slice(1, -1).reverse()];
          midi = [cycle[idx % cycle.length]! + up];
          break;
        }
        case "motif":
          midi = [v[motif[idx % motif.length]! % v.length]! + up + (idx % 8 === 7 ? 12 : 0)];
          break;
      }
      idx++;
      notes.push({
        at,
        inst: top.inst,
        midi,
        lenS: lenTo(at, Math.max(0.5, h.lenSteps * harmony.legato) * stepS),
        vel: charVelocity(h.ch) * db(top.gainDb) * g,
        pan: top.mode === "chord" || top.mode === "pulse" ? 0.15 : idx % 2 ? 0.3 : -0.3,
        bus: "top",
        send: top.send,
        variant: 0,
      });
    }
  }

  // texture under everything (until the groove ends)
  if (style.texture && grooveEnd > 0) {
    notes.push({
      at: 0,
      inst: style.texture.inst,
      midi: [tonic + 12],
      lenS: grooveEnd / SR,
      vel: db(style.texture.gainDb),
      pan: 0,
      bus: "texture",
      send: style.texture.inst === "drone" ? 0.4 : 0,
      variant: 0,
    });
  }

  // risers: noise build + reverse cymbal into the target + a roll that accelerates
  const riserEnds = new Set<number>();
  for (const r of events.risers) {
    const s = toS(r.startMs);
    const e = toS(r.endMs);
    riserEnds.add(e);
    notes.push({
      at: s,
      inst: "riser",
      midi: [],
      lenS: (e - s) / SR,
      vel: 0.5,
      pan: 0,
      bus: "fx",
      send: 0.2,
      variant: 0,
    });
    const rc = Math.min(beatSamples, e - s);
    notes.push({
      at: e - Math.round(rc),
      inst: "reverse_cymbal",
      midi: [],
      lenS: rc / SR,
      vel: 0.45,
      pan: 0,
      bus: "fx",
      send: 0.1,
      variant: 0,
    });
    if (style.fill !== "none") {
      const k0 = Math.ceil(s / stepSamples);
      const k1 = Math.floor((e - 1) / stepSamples);
      for (let k = k0; k <= k1; k++) {
        const p = (k - k0) / Math.max(1, k1 - k0 + 1);
        const every = p < 0.5 ? 4 : p < 0.75 ? 2 : 1;
        if ((k - k0) % every !== 0) continue;
        const at = Math.round(k * stepSamples);
        if (at >= e) continue;
        notes.push({
          at,
          inst: style.fill,
          midi: style.fill === "tom" ? [tonic + 12 - Math.round(p * 7)] : [],
          lenS: stepS,
          vel: (0.18 + 0.5 * p) * db(-4),
          pan: 0,
          bus: "fx",
          send: 0.2,
          variant: k % 3,
        });
      }
    }
  }

  // accents: drops (crash + boom), a short reverse swell into any accent no riser leads to
  for (const d of events.drops) {
    const at = toS(d);
    notes.push({
      at,
      inst: "crash",
      midi: [],
      lenS: 2,
      vel: 0.42,
      pan: 0.1,
      bus: "hit",
      send: 0.25,
      variant: 0,
    });
    notes.push({ at, inst: "boom", midi: [], lenS: 1.2, vel: 0.5, pan: 0, bus: "hit", send: 0, variant: 0 });
    if (intent.genre === "cinematic")
      notes.push({
        at,
        inst: "taiko",
        midi: [],
        lenS: 1,
        vel: 0.9,
        pan: 0,
        bus: "hit",
        send: 0.4,
        variant: 0,
      });
  }
  for (const a of accents) {
    if ([...riserEnds].some((e) => Math.abs(e - a) < stepSamples)) continue;
    const len = Math.min(beatSamples, a);
    if (len < stepSamples) continue;
    notes.push({
      at: a - Math.round(len),
      inst: "reverse_cymbal",
      midi: [],
      lenS: len / SR,
      vel: 0.3,
      pan: 0,
      bus: "fx",
      send: 0.1,
      variant: 0,
    });
  }

  // the final hit: everything lands on one sample, then rings out
  if (events.finalHitMs !== undefined) {
    const at = toS(events.finalHitMs);
    const end = events.stopMs !== undefined ? toS(events.stopMs) : samples;
    const tail = Math.max(0.15, Math.min(4, (end - at) / SR));
    const chord = voicings[chordIdx(Math.floor(at / stepSamples))]!;
    const hitChord = [tonic + 12, ...chord, chord[chord.length - 1]! + 12];
    const hit = (inst: string, midi: number[], lenS: number, vel: number, send: number) =>
      notes.push({ at, inst, midi, lenS, vel, pan: 0, bus: "hit", send, variant: 0 });
    hit("kick_hard", [], 0.4, 1, 0.1);
    hit("boom", [], Math.min(2.2, tail + 0.2), 0.85, 0);
    hit("crash", [], Math.min(2.8, tail + 0.4), 0.6, 0.3);
    hit("stab", hitChord, tail, 0.32, 0.45);
    hit(
      intent.genre === "cinematic" ? "strings" : style.harmony.inst === "guitar" ? "guitar" : "pad",
      chord,
      tail,
      0.3,
      0.5,
    );
    hit(
      "sub",
      [bassNote(tonic, progression[chordIdx(Math.floor(at / stepSamples))]!)],
      Math.min(1.6, tail),
      0.55,
      0,
    );
    if (intent.genre === "cinematic") hit("taiko", [], 1, 1, 0.4);
    if (intent.genre === "funk")
      hit(
        "brass",
        chord.map((n) => n + 12),
        Math.min(0.6, tail),
        0.3,
        0.3,
      );
    kicks.push(at);
  }

  notes.sort((a, b) => a.at - b.at || a.inst.localeCompare(b.inst));
  return {
    intent,
    style,
    harmony,
    samples,
    bpm,
    stepSamples,
    beatSamples,
    barSamples,
    tonic,
    progression,
    voicings,
    events,
    notes,
    kicks: kicks.sort((a, b) => a - b),
    energyAt,
    seed,
  };
}
