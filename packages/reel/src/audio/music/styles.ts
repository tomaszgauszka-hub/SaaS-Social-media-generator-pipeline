import type { MusicGenre, MusicMood } from "../../contracts/ids.ts";

/**
 * What the local composer knows about each genre (instrumentation, patterns, groove, mix) and each mood (key,
 * scale, chord progressions, harmonic rhythm, brightness). Tables are typed against the contract enums, so a new
 * genre / mood id fails the type check until it has a style here.
 *
 * Pattern grammar — one char per 16th note, 16 (one bar) or 32 (two bars) chars, repeated:
 *   drums / stabs / arps:  X accent · x normal · o ghost · . rest · - tie (holds the previous note)
 *   bass:                  X/x root · o ghost root · O octave up · 5 fifth · - tie · . rest
 *   guitar strums:         D down · U up · m muted chop · . rest
 */

export type DrumInst =
  | "kick"
  | "kick_soft"
  | "kick_hard"
  | "snare"
  | "clap"
  | "hat"
  | "open_hat"
  | "shaker"
  | "rim"
  | "metal"
  | "tom"
  | "taiko"
  | "ride";
export type BassInst = "sub" | "saw_bass" | "fm_bass" | "slap" | "pluck_bass";
export type HarmonyInst = "pad" | "rhodes" | "organ" | "guitar" | "strings" | "piano" | "stab";
export type TopInst =
  "pluck" | "bell" | "glock" | "marimba" | "brass" | "arp_saw" | "strings_stacc" | "piano";
export type FillInst = "snare" | "clap" | "tom" | "none";

export interface DrumLane {
  inst: DrumInst;
  pattern: string;
  gainDb: number;
  /** the lane plays only at or above this energy (0..1) */
  minEnergy: number;
  pan?: number;
  send?: number;
}

export interface GenreStyle {
  drums: DrumLane[];
  /** fraction of a 16th the off-16ths are delayed (groove) */
  swing: number;
  bass: { inst: BassInst; pattern: string; gainDb: number; minEnergy: number; octave: number };
  harmony: {
    inst: HarmonyInst;
    /** "hold" = one chord per harmonic-rhythm slot */
    pattern: string;
    gainDb: number;
    minEnergy: number;
    send: number;
  };
  /** sustained pad under a rhythmic harmony part */
  pad?: { inst: "pad" | "strings"; gainDb: number; minEnergy: number; send: number };
  top?: {
    inst: TopInst;
    pattern: string;
    mode: "arp_up" | "arp_updown" | "motif" | "chord" | "pulse";
    octave: number;
    gainDb: number;
    minEnergy: number;
    send: number;
    /** tempo-synced echo (beats) */
    delayBeats?: number;
  };
  texture?: { inst: "vinyl" | "drone"; gainDb: number };
  /** roll used during risers */
  fill: FillInst;
  /** sidechain pump depth (dB) on bass / harmony / top */
  pumpDb: number;
  reverb: { room: number; damp: number };
  /** master saturation drive (0 = clean) */
  drive: number;
  /** lo-fi tape tone (gentle low-pass + saturation) */
  tape: boolean;
  /** bus levels relative to the drums (dB, active RMS) — the mix is set to these targets */
  mix: { drums: number; bass: number; harmony: number; pad: number; top: number; texture: number };
}

export const GENRE_STYLES: Record<MusicGenre, GenreStyle> = {
  industrial_electronic: {
    drums: [
      { inst: "kick_hard", pattern: "X...X...X...X...", gainDb: -1, minEnergy: 0.3 },
      { inst: "clap", pattern: "....X.......X...", gainDb: -5, minEnergy: 0.45, send: 0.25 },
      { inst: "metal", pattern: "..x...o...x..o..", gainDb: -12, minEnergy: 0.55, pan: 0.35, send: 0.2 },
      { inst: "hat", pattern: "..x...x...x...x.", gainDb: -7, minEnergy: 0.35, pan: -0.25 },
      { inst: "hat", pattern: "o.o.o.o.o.o.o.o.", gainDb: -11, minEnergy: 0.75, pan: 0.25 },
    ],
    swing: 0,
    bass: { inst: "fm_bass", pattern: "X.xx.xx.X.xx.xxo", gainDb: -6, minEnergy: 0.2, octave: 0 },
    harmony: { inst: "stab", pattern: "hold", gainDb: -15, minEnergy: 0, send: 0.25 },
    top: {
      inst: "arp_saw",
      pattern: "xxxxxxxxxxxxxxxx",
      mode: "arp_updown",
      octave: 1,
      gainDb: -18,
      minEnergy: 0.65,
      send: 0.15,
      delayBeats: 0.75,
    },
    fill: "snare",
    pumpDb: 4,
    reverb: { room: 0.6, damp: 0.4 },
    drive: 1.8,
    tape: false,
    mix: { drums: 0, bass: -1, harmony: -7, pad: -12, top: -8, texture: -20 },
  },
  lofi_house: {
    drums: [
      { inst: "kick_soft", pattern: "X...X...X...X...", gainDb: -2, minEnergy: 0.3 },
      { inst: "clap", pattern: "....x.......x...", gainDb: -8, minEnergy: 0.45, send: 0.3 },
      { inst: "open_hat", pattern: "..x...x...x...x.", gainDb: -11, minEnergy: 0.35, pan: 0.3 },
      { inst: "shaker", pattern: "x.o.x.o.x.o.x.oo", gainDb: -10, minEnergy: 0.55, pan: -0.3 },
    ],
    swing: 0.14,
    bass: { inst: "saw_bass", pattern: "x.....x...x.....", gainDb: -6, minEnergy: 0.2, octave: 0 },
    harmony: { inst: "rhodes", pattern: "x-----x---.x----", gainDb: -9, minEnergy: 0, send: 0.3 },
    pad: { inst: "pad", gainDb: -21, minEnergy: 0, send: 0.3 },
    top: {
      inst: "marimba",
      pattern: "x..x..x...x..x..",
      mode: "motif",
      octave: 1,
      gainDb: -15,
      minEnergy: 0.7,
      send: 0.3,
      delayBeats: 0.75,
    },
    texture: { inst: "vinyl", gainDb: -24 },
    fill: "clap",
    pumpDb: 3,
    reverb: { room: 0.7, damp: 0.6 },
    drive: 1.1,
    tape: true,
    mix: { drums: 0, bass: -3, harmony: -3, pad: -10, top: -7, texture: -16 },
  },
  cinematic: {
    drums: [
      { inst: "taiko", pattern: "X.......x.....o.", gainDb: -2, minEnergy: 0.5, send: 0.35 },
      {
        inst: "tom",
        pattern: "........o.o.....x.......o...x.x.",
        gainDb: -9,
        minEnergy: 0.7,
        pan: 0.3,
        send: 0.3,
      },
      { inst: "shaker", pattern: "x.o.x.o.x.o.x.o.", gainDb: -14, minEnergy: 0.6, pan: -0.35 },
    ],
    swing: 0,
    bass: { inst: "sub", pattern: "X---------------", gainDb: -6, minEnergy: 0.25, octave: 0 },
    harmony: { inst: "strings", pattern: "hold", gainDb: -8, minEnergy: 0, send: 0.4 },
    top: {
      inst: "strings_stacc",
      pattern: "x.x.x.x.x.x.x.x.",
      mode: "pulse",
      octave: 0,
      gainDb: -11,
      minEnergy: 0.35,
      send: 0.25,
    },
    fill: "tom",
    pumpDb: 0,
    reverb: { room: 0.88, damp: 0.35 },
    drive: 0,
    tape: false,
    mix: { drums: -3, bass: -4, harmony: 0, pad: -8, top: -2, texture: -14 },
  },
  minimal_tech: {
    drums: [
      { inst: "kick", pattern: "X...X...X...X...", gainDb: -1, minEnergy: 0.3 },
      { inst: "rim", pattern: "...x..x....x..x.", gainDb: -12, minEnergy: 0.45, pan: 0.3, send: 0.15 },
      { inst: "clap", pattern: "....x.......x...", gainDb: -9, minEnergy: 0.6, send: 0.25 },
      { inst: "hat", pattern: "..x...x...x...x.", gainDb: -7, minEnergy: 0.35, pan: -0.2 },
      { inst: "hat", pattern: "o.o.o.o.o.o.o.o.", gainDb: -13, minEnergy: 0.75, pan: 0.2 },
    ],
    swing: 0.04,
    bass: { inst: "sub", pattern: "..x...x...x...x.", gainDb: -5, minEnergy: 0.2, octave: 0 },
    harmony: { inst: "pad", pattern: "hold", gainDb: -16, minEnergy: 0, send: 0.35 },
    top: {
      inst: "pluck",
      pattern: "x..x..x..x..x.x.",
      mode: "arp_up",
      octave: 1,
      gainDb: -13,
      minEnergy: 0.5,
      send: 0.2,
      delayBeats: 0.75,
    },
    fill: "clap",
    pumpDb: 3,
    reverb: { room: 0.7, damp: 0.5 },
    drive: 0.6,
    tape: false,
    mix: { drums: 0, bass: -2, harmony: -9, pad: -12, top: -6, texture: -18 },
  },
  acoustic_pop: {
    drums: [
      { inst: "kick_soft", pattern: "X.......X.x.....", gainDb: -2, minEnergy: 0.35 },
      { inst: "clap", pattern: "....X.......X...", gainDb: -7, minEnergy: 0.45, send: 0.25 },
      { inst: "shaker", pattern: "xoxoxoxoxoxoxoxo", gainDb: -10, minEnergy: 0.3, pan: 0.3 },
    ],
    swing: 0.05,
    bass: { inst: "pluck_bass", pattern: "x.....x.x.......", gainDb: -5, minEnergy: 0.25, octave: 0 },
    harmony: { inst: "guitar", pattern: "D...D.U...U.D.U.", gainDb: -6, minEnergy: 0, send: 0.2 },
    pad: { inst: "pad", gainDb: -24, minEnergy: 0, send: 0.25 },
    top: {
      inst: "glock",
      pattern: "x...x...x.x.x...",
      mode: "motif",
      octave: 1,
      gainDb: -15,
      minEnergy: 0.6,
      send: 0.3,
    },
    fill: "clap",
    pumpDb: 0,
    reverb: { room: 0.55, damp: 0.5 },
    drive: 0,
    tape: false,
    mix: { drums: -1, bass: -4, harmony: 0, pad: -12, top: -7, texture: -18 },
  },
  deep_house: {
    drums: [
      { inst: "kick", pattern: "X...X...X...X...", gainDb: -1, minEnergy: 0.3 },
      { inst: "clap", pattern: "....X.......X...", gainDb: -7, minEnergy: 0.5, send: 0.3 },
      { inst: "open_hat", pattern: "..x...x...x...x.", gainDb: -9, minEnergy: 0.35, pan: 0.25 },
      { inst: "shaker", pattern: "xoxoxoxoxoxoxoxo", gainDb: -13, minEnergy: 0.6, pan: -0.3 },
    ],
    swing: 0.06,
    bass: { inst: "saw_bass", pattern: "..x...x...xo..x.", gainDb: -5, minEnergy: 0.2, octave: 0 },
    harmony: { inst: "organ", pattern: "...x..x....x..x.", gainDb: -12, minEnergy: 0.15, send: 0.3 },
    pad: { inst: "pad", gainDb: -18, minEnergy: 0, send: 0.35 },
    top: {
      inst: "bell",
      pattern: "x..x..x..x..x...",
      mode: "arp_updown",
      octave: 1,
      gainDb: -19,
      minEnergy: 0.75,
      send: 0.35,
      delayBeats: 0.75,
    },
    fill: "clap",
    pumpDb: 5,
    reverb: { room: 0.65, damp: 0.5 },
    drive: 0.5,
    tape: false,
    mix: { drums: 0, bass: -2, harmony: -5, pad: -9, top: -9, texture: -18 },
  },
  ambient: {
    drums: [
      { inst: "kick_soft", pattern: "X...............", gainDb: -6, minEnergy: 0.75 },
      { inst: "shaker", pattern: "x.o.x.o.x.o.x.o.", gainDb: -16, minEnergy: 0.6, pan: 0.3, send: 0.3 },
    ],
    swing: 0,
    bass: { inst: "sub", pattern: "X---------------", gainDb: -9, minEnergy: 0.4, octave: 0 },
    harmony: { inst: "pad", pattern: "hold", gainDb: -7, minEnergy: 0, send: 0.5 },
    top: {
      inst: "bell",
      pattern: "x.......x...x...",
      mode: "arp_updown",
      octave: 1,
      gainDb: -16,
      minEnergy: 0.3,
      send: 0.55,
      delayBeats: 1.5,
    },
    texture: { inst: "drone", gainDb: -16 },
    fill: "none",
    pumpDb: 0,
    reverb: { room: 0.93, damp: 0.3 },
    drive: 0,
    tape: false,
    mix: { drums: -9, bass: -6, harmony: 0, pad: -6, top: -5, texture: -7 },
  },
  funk: {
    drums: [
      { inst: "kick", pattern: "X.....x...X..x..", gainDb: -1, minEnergy: 0.3 },
      { inst: "snare", pattern: "....X..o.o..X..o", gainDb: -5, minEnergy: 0.4, send: 0.15 },
      { inst: "hat", pattern: "xoxoxoxoxoxoxoxo", gainDb: -8, minEnergy: 0.35, pan: 0.25 },
      { inst: "open_hat", pattern: "......x.......x.", gainDb: -10, minEnergy: 0.65, pan: 0.25 },
    ],
    swing: 0.1,
    bass: { inst: "slap", pattern: "X..O..x.X.O..x.o", gainDb: -4, minEnergy: 0.2, octave: 0 },
    harmony: { inst: "guitar", pattern: ".m.m.mm..m.m.mm.", gainDb: -9, minEnergy: 0.15, send: 0.15 },
    pad: { inst: "pad", gainDb: -23, minEnergy: 0, send: 0.2 },
    top: {
      inst: "brass",
      pattern: "X-.....x.x-.....",
      mode: "chord",
      octave: 0,
      gainDb: -12,
      minEnergy: 0.65,
      send: 0.2,
    },
    fill: "snare",
    pumpDb: 0,
    reverb: { room: 0.45, damp: 0.5 },
    drive: 0.4,
    tape: false,
    mix: { drums: 0, bass: -1, harmony: -5, pad: -12, top: -5, texture: -18 },
  },
};

/* ------------------------------------------------------------------ moods (harmony) -------------- */

/** a chord: root (semitones above the tonic) and tones (semitones above the chord root) */
export interface Chord {
  root: number;
  tones: readonly number[];
}

const MAJ = [0, 4, 7];
const MIN = [0, 3, 7];
const MAJ7 = [0, 4, 7, 11];
const MIN7 = [0, 3, 7, 10];
const DOM7 = [0, 4, 7, 10];
const SUS7 = [0, 5, 7, 10];
const ADD9 = [0, 4, 7, 14];
const MAJ9 = [0, 4, 11, 14];
const MIN9 = [0, 3, 10, 14];
const c = (root: number, tones: readonly number[]): Chord => ({ root, tones });

export interface MoodHarmony {
  /** progression variants (one is picked by the seed) */
  progressions: readonly (readonly Chord[])[];
  /** candidate tonics (MIDI, bass register) */
  tonics: readonly number[];
  /** bars per chord (harmonic rhythm) */
  barsPerChord: 1 | 2;
  /** tone: multiplies the energy-driven low-pass cutoff */
  brightness: number;
  /** extra swing on top of the genre's */
  swing: number;
  /** stab / arp note length factor (legato 1 … staccato 0.4) */
  legato: number;
  /** level of the whole bed relative to its energy (dB) */
  energyBias: number;
}

export const MOOD_HARMONY: Record<MusicMood, MoodHarmony> = {
  confident: {
    progressions: [
      [c(0, MIN), c(8, MAJ), c(3, MAJ), c(10, MAJ)],
      [c(0, MIN), c(10, MAJ), c(8, MAJ), c(10, MAJ)],
    ],
    tonics: [45, 43, 40, 42],
    barsPerChord: 1,
    brightness: 1.05,
    swing: 0,
    legato: 0.8,
    energyBias: 0,
  },
  warm: {
    progressions: [
      [c(0, MAJ7), c(9, MIN7), c(5, MAJ7), c(7, SUS7)],
      [c(0, ADD9), c(5, MAJ7), c(9, MIN7), c(7, ADD9)],
    ],
    tonics: [41, 43, 45, 38],
    barsPerChord: 1,
    brightness: 0.85,
    swing: 0.04,
    legato: 0.9,
    energyBias: -0.05,
  },
  uplifting: {
    progressions: [
      [c(0, MAJ), c(7, MAJ), c(9, MIN), c(5, MAJ)],
      [c(5, MAJ), c(7, MAJ), c(9, MIN), c(0, MAJ)],
    ],
    tonics: [43, 45, 40, 47],
    barsPerChord: 1,
    brightness: 1.2,
    swing: 0,
    legato: 0.75,
    energyBias: 0.05,
  },
  calm: {
    progressions: [
      [c(0, MAJ7), c(5, MAJ7)],
      [c(0, MAJ9), c(9, MIN9)],
    ],
    tonics: [41, 38, 43, 40],
    barsPerChord: 2,
    brightness: 0.75,
    swing: 0.03,
    legato: 1,
    energyBias: -0.1,
  },
  energetic: {
    progressions: [
      [c(0, MIN), c(10, MAJ), c(8, MAJ), c(10, MAJ)],
      [c(0, MIN), c(8, MAJ), c(3, MAJ), c(10, MAJ)],
    ],
    tonics: [45, 42, 44, 40],
    barsPerChord: 1,
    brightness: 1.25,
    swing: 0,
    legato: 0.6,
    energyBias: 0.1,
  },
  dark: {
    progressions: [
      [c(0, MIN), c(1, MAJ), c(0, MIN), c(10, MAJ)],
      [c(0, MIN), c(8, MAJ), c(5, MIN), c(7, MAJ)],
    ],
    tonics: [40, 38, 41, 37],
    barsPerChord: 1,
    brightness: 0.7,
    swing: 0,
    legato: 0.85,
    energyBias: 0,
  },
  playful: {
    progressions: [
      [c(0, MAJ), c(9, MIN), c(2, MIN), c(7, DOM7)],
      [c(0, MAJ), c(9, DOM7), c(2, MIN), c(7, DOM7)],
    ],
    tonics: [43, 45, 47, 41],
    barsPerChord: 1,
    brightness: 1.15,
    swing: 0.1,
    legato: 0.45,
    energyBias: 0.05,
  },
  elegant: {
    progressions: [
      [c(2, MIN9), c(7, DOM7), c(0, MAJ9), c(9, MIN7)],
      [c(0, MAJ7), c(4, MIN7), c(9, MIN7), c(5, MAJ7)],
    ],
    tonics: [41, 43, 38, 46],
    barsPerChord: 1,
    brightness: 0.95,
    swing: 0.02,
    legato: 0.85,
    energyBias: -0.05,
  },
};

/** velocity of a pattern char (0 = rest / tie) */
export function charVelocity(ch: string): number {
  switch (ch) {
    case "X":
    case "D":
      return 1;
    case "x":
    case "5":
      return 0.8;
    case "O":
      return 0.85;
    case "U":
      return 0.75;
    case "m":
      return 0.6;
    case "o":
      return 0.45;
    default:
      return 0;
  }
}
