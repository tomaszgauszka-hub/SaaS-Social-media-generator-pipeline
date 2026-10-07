import type { MusicMood } from "@cre/creative";
import {
  SR,
  addMono,
  bell,
  clap,
  dbGain,
  hat,
  keys,
  kick,
  midiHz,
  pluck,
  prng,
  sawVoice,
  shaker,
  snare,
  stereo,
  type Stereo,
} from "./synth.ts";

/**
 * Generated music beds per mood (spec §36 AudioDirector): a 4-chord loop with drums, bass, pad and an
 * arpeggio/pluck layer, quantised to the storyboard BPM — beat cuts land on the grid the director used.
 */
interface Chord {
  notes: number[];
  root: number;
}

interface MoodPreset {
  chords: Chord[];
  kick?: string;
  snare?: string;
  clap?: string;
  hat?: string;
  openHat?: string;
  shaker?: string;
  bass: { pattern: string; type: "saw" | "square"; cutoff: number; gainDb: number };
  pad?: { gainDb: number; cutoff: number };
  arp?: { pattern: string; inst: "pluck" | "keys" | "bell" | "saw"; octave: number; gainDb: number };
  keysChords?: { pattern: string; gainDb: number };
  swing: number;
  drumsDb: number;
}

const C = (notes: number[], root: number): Chord => ({ notes, root });

export const MOODS: Record<MusicMood, MoodPreset> = {
  drive: {
    chords: [C([57, 60, 64], 45), C([57, 60, 65], 41), C([55, 60, 64], 48), C([55, 59, 62], 43)],
    kick: "x...x...x...x.x.",
    snare: "....x.......x...",
    hat: "xxxxxxxxxxxxxxxx",
    openHat: "..x...x...x...x.",
    bass: { pattern: "x.xxx.xxx.xxx.xx", type: "saw", cutoff: 520, gainDb: -6 },
    pad: { gainDb: -20, cutoff: 1400 },
    arp: { pattern: "x..x..x.x..x..x.", inst: "pluck", octave: 12, gainDb: -14 },
    swing: 0,
    drumsDb: -4,
  },
  tech: {
    chords: [C([57, 60, 62, 65], 38), C([57, 58, 62, 65], 46), C([57, 60, 65], 41), C([55, 60, 64], 48)],
    kick: "x.....x...x.....",
    clap: "....x.......x...",
    hat: "x.x.x.x.x.x.x.x.",
    bass: { pattern: "x..x..x...x..x..", type: "square", cutoff: 760, gainDb: -9 },
    pad: { gainDb: -18, cutoff: 2200 },
    arp: { pattern: "xxxxxxxxxxxxxxxx", inst: "saw", octave: 12, gainDb: -19 },
    swing: 0,
    drumsDb: -6,
  },
  chill: {
    chords: [
      C([59, 60, 64, 67], 48),
      C([57, 60, 64, 67], 45),
      C([57, 60, 64, 65], 41),
      C([55, 59, 62, 64], 43),
    ],
    kick: "x.......x.....x.",
    clap: "....x.......x...",
    shaker: "x.x.x.x.x.x.x.x.",
    bass: { pattern: "x.......x...x...", type: "saw", cutoff: 300, gainDb: -8 },
    pad: { gainDb: -17, cutoff: 1600 },
    keysChords: { pattern: "x.....x.....x...", gainDb: -15 },
    swing: 0.08,
    drumsDb: -11,
  },
  elegant: {
    chords: [
      C([57, 60, 64, 65], 41),
      C([55, 59, 62, 64], 40),
      C([57, 60, 62, 65], 38),
      C([55, 59, 60, 64], 36),
    ],
    shaker: "..x...x...x...x.",
    bass: { pattern: "x...............", type: "saw", cutoff: 220, gainDb: -10 },
    pad: { gainDb: -14, cutoff: 1300 },
    arp: { pattern: "x.x.x.x.x.x.x.x.", inst: "keys", octave: 12, gainDb: -13 },
    swing: 0,
    drumsDb: -16,
  },
  warm: {
    chords: [C([60, 64, 67], 48), C([59, 62, 67], 43), C([60, 64, 69], 45), C([60, 65, 69], 41)],
    kick: "x.......x.......",
    clap: "....x.......x...",
    shaker: "x.x.x.x.x.x.x.x.",
    bass: { pattern: "x.....x.x.......", type: "saw", cutoff: 420, gainDb: -8 },
    pad: { gainDb: -21, cutoff: 1800 },
    arp: { pattern: "x..x..x...x.x...", inst: "pluck", octave: 12, gainDb: -10 },
    swing: 0.12,
    drumsDb: -8,
  },
  upbeat: {
    chords: [C([59, 62, 67], 43), C([57, 62, 66], 38), C([59, 64, 67], 40), C([60, 64, 67], 48)],
    kick: "x...x...x...x...",
    clap: "....x.......x...",
    openHat: "..x...x...x...x.",
    bass: { pattern: "x.x.x.x.x.x.x.x.", type: "saw", cutoff: 600, gainDb: -8 },
    pad: { gainDb: -20, cutoff: 1800 },
    arp: { pattern: "x.xx.x.xx.x.x.xx", inst: "pluck", octave: 12, gainDb: -12 },
    swing: 0,
    drumsDb: -6,
  },
};

const hit = (pattern: string | undefined, step: number) => Boolean(pattern && pattern[step % 16] === "x");

/** Render `samples` of music for a mood/tempo (deterministic for a seed). */
export function renderMusic(mood: MusicMood, bpm: number, samples: number, seed: number): Stereo {
  const p = MOODS[mood];
  const bus = stereo(samples);
  const rand = prng(seed);
  const stepS = 60 / bpm / 4;
  const steps = Math.ceil(samples / SR / stepS) + 1;
  const bars = Math.ceil(steps / 16);
  const drums = dbGain(p.drumsDb);
  // pre-rendered one-shots (variation from the seeded PRNG)
  const K = kick();
  const S = snare(rand);
  const CL = clap(rand);
  const H = [hat(rand), hat(rand), hat(rand)];
  const OH = hat(rand, true);
  const SH = [shaker(rand), shaker(rand)];
  const at = (step: number) => {
    const swing = step % 2 === 1 ? p.swing * stepS : 0;
    return Math.round((step * stepS + swing) * SR);
  };
  const lastBar = bars - 1;
  for (let step = 0; step < steps; step++) {
    const bar = Math.floor(step / 16);
    const s16 = step % 16;
    const chord = p.chords[bar % p.chords.length]!;
    const t = at(step);
    const fill = bar === lastBar - 1 && s16 >= 12;
    // drums
    if (hit(p.kick, s16)) addMono(bus, K, t, drums * 0.9);
    if (hit(p.snare, s16) || (fill && p.snare))
      addMono(bus, S, t, drums * (fill ? 0.35 + (s16 - 12) * 0.12 : 0.55), 0.05);
    if (hit(p.clap, s16) || (fill && p.clap && !p.snare))
      addMono(bus, CL, t, drums * (fill ? 0.3 + (s16 - 12) * 0.1 : 0.5), -0.05);
    if (hit(p.hat, s16)) addMono(bus, H[step % 3]!, t, drums * (s16 % 4 === 2 ? 0.22 : 0.12), 0.3);
    if (hit(p.openHat, s16)) addMono(bus, OH, t, drums * 0.14, 0.35);
    if (hit(p.shaker, s16)) addMono(bus, SH[step % 2]!, t, drums * (s16 % 4 === 0 ? 0.32 : 0.22), -0.3);
    // bass
    if (hit(p.bass.pattern, s16)) {
      const len = stepS * (p.bass.pattern[(s16 + 1) % 16] === "x" ? 0.9 : 1.8);
      const v = sawVoice(midiHz(chord.root), len, {
        cutoff: p.bass.cutoff,
        cutoffEnv: p.bass.cutoff * 1.4,
        square: p.bass.type === "square",
        a: 0.004,
        d: 0.12,
        s: 0.7,
        r: 0.05,
      });
      addMono(bus, v, t, dbGain(p.bass.gainDb) * 0.8);
    }
    // pad: once per bar
    if (p.pad && s16 === 0) {
      chord.notes.forEach((n, i) => {
        const v = sawVoice(midiHz(n), stepS * 16 * 0.98, {
          voices: 3,
          detune: 0.008,
          cutoff: p.pad!.cutoff,
          a: 0.25,
          d: 0.4,
          s: 0.8,
          r: 0.4,
        });
        addMono(bus, v, t, (dbGain(p.pad!.gainDb) * 0.6) / chord.notes.length, i % 2 ? 0.45 : -0.45);
      });
    }
    // chord stabs (keys)
    if (p.keysChords && hit(p.keysChords.pattern, s16)) {
      chord.notes.forEach((n, i) =>
        addMono(
          bus,
          keys(midiHz(n + 12), stepS * 3, 0.3),
          t,
          dbGain(p.keysChords!.gainDb) / chord.notes.length,
          (i - 1) * 0.3,
        ),
      );
    }
    // arpeggio / plucks over the chord tones
    if (p.arp && hit(p.arp.pattern, s16)) {
      const tones = chord.notes;
      const n = tones[(s16 + bar) % tones.length]! + p.arp.octave + (s16 % 8 >= 6 ? 12 : 0);
      const hz = midiHz(n);
      const v =
        p.arp.inst === "pluck"
          ? pluck(hz, stepS * 3, rand, 0.55)
          : p.arp.inst === "keys"
            ? keys(hz, stepS * 1.6, 0.35)
            : p.arp.inst === "bell"
              ? bell(hz, stepS * 4)
              : sawVoice(hz, stepS * 0.7, {
                  voices: 2,
                  detune: 0.005,
                  cutoff: 2600,
                  cutoffEnv: 2400,
                  a: 0.002,
                  d: 0.08,
                  s: 0.3,
                  r: 0.05,
                });
      addMono(bus, v, t, dbGain(p.arp.gainDb), s16 % 2 ? 0.35 : -0.35);
    }
  }
  return bus;
}
