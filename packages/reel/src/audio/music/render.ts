import type { MusicIntent } from "../../contracts/plan.ts";
import {
  SR,
  addMono,
  applyGainCurve,
  bell,
  biquad,
  boom,
  brass,
  clap,
  crash,
  dbGain,
  drone,
  duckCurve,
  fmBass,
  guitarStrum,
  hat,
  keys,
  kick,
  limit,
  lowpass,
  mallet,
  metalPerc,
  midiHz,
  mutedGuitar,
  noiseRiser,
  organ,
  peak,
  piano,
  pingPongDelay,
  pluck,
  prng,
  reverb,
  reverseCymbal,
  ride,
  rim,
  saturate,
  sawVoice,
  shaker,
  slapBass,
  snare,
  stereo,
  strings,
  subBass,
  svf,
  tom,
  vinylCrackle,
  type Stereo,
} from "../synth.ts";
import { arrange, type Arrangement, type ArrangedNote, type Bus } from "./arrange.ts";

/**
 * Renders an arrangement to a mastered 48 kHz stereo bed:
 *
 *   notes → buses (drums · bass · harmony · pad · top · texture · fx · hit) + reverb sends
 *   groove = drums + pumped (sidechained) bass/harmony/pad/top + echo + reverb
 *        → drive / tape → riser high-pass sweep → energy low-pass (tone follows energy) → energy level
 *   + fx (risers, swells) + hits (drops, final hit) with their own reverb, unfiltered
 *   → stop gate → master: low-pass 16.5 kHz, level to −14 dBFS (loud windows), look-ahead limiter −1.5 dBFS
 */

export const LOCAL_MUSIC_VERSION = "local-music/1";

/** peak ceiling of the master (dBFS) */
export const MUSIC_CEILING_DB = -1.5;

const voiceCache = new WeakMap<Arrangement, Map<string, Float32Array>>();

function chordSum(midi: readonly number[], one: (hz: number) => Float32Array): Float32Array {
  const parts = midi.map((m) => one(midiHz(m)));
  const n = Math.max(...parts.map((p) => p.length));
  const out = new Float32Array(n);
  const g = 1 / Math.sqrt(Math.max(1, parts.length));
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i]! += p[i]! * g;
  return out;
}

/** mono voice for a note (cached per arrangement: identical notes reuse one buffer) */
function voice(arr: Arrangement, note: ArrangedNote, rand: () => number): Float32Array {
  let cache = voiceCache.get(arr);
  if (!cache) {
    cache = new Map();
    voiceCache.set(arr, cache);
  }
  const key = `${note.inst}|${note.midi.join(",")}|${note.lenS.toFixed(3)}|${note.variant}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const len = note.lenS;
  const hz = note.midi[0] !== undefined ? midiHz(note.midi[0]) : 0;
  let v: Float32Array;
  switch (note.inst) {
    // drums
    case "kick":
      v = kick(1);
      break;
    case "kick_soft":
      v = lowpass(kick(0.75), 1100);
      break;
    case "kick_hard":
      v = saturate(kick(1.35), 2.2);
      break;
    case "snare":
      v = snare(rand);
      break;
    case "clap":
      v = clap(rand);
      break;
    case "hat":
      v = hat(rand);
      break;
    case "open_hat":
      v = hat(rand, true);
      break;
    case "shaker":
      v = shaker(rand);
      break;
    case "rim":
      v = rim(rand);
      break;
    case "metal":
      v = metalPerc(rand, 360 + 45 * note.variant);
      break;
    case "tom":
      v = tom(hz || 98 + 22 * note.variant, rand);
      break;
    case "taiko": {
      const t = tom(58, rand, 0.5);
      const b = boom(0.9, 80, 42);
      v = new Float32Array(Math.max(t.length, b.length));
      for (let i = 0; i < v.length; i++) v[i] = (t[i] ?? 0) * 0.8 + (b[i] ?? 0) * 0.5;
      break;
    }
    case "ride":
      v = ride(rand);
      break;
    // accents / fx
    case "crash":
      v = crash(rand, Math.max(0.8, len));
      break;
    case "boom":
      v = boom(Math.max(0.5, len));
      break;
    case "riser":
      v = noiseRiser(Math.max(0.2, len), rand);
      break;
    case "reverse_cymbal":
      v = reverseCymbal(rand, Math.max(0.1, len));
      break;
    case "vinyl":
      v = vinylCrackle(Math.round(len * SR), rand);
      break;
    case "drone":
      v = drone(hz, Math.max(1.7, len), rand);
      break;
    // bass
    case "sub":
      v = subBass(hz, len);
      break;
    case "saw_bass": {
      const saw = sawVoice(hz, len, {
        voices: 2,
        detune: 0.004,
        cutoff: 420,
        cutoffEnv: 700,
        a: 0.004,
        d: 0.15,
        s: 0.7,
        r: 0.05,
      });
      const sub = subBass(hz, len, { drive: 1.2 });
      v = new Float32Array(Math.max(saw.length, sub.length));
      for (let i = 0; i < v.length; i++) v[i] = (saw[i] ?? 0) * 0.75 + (sub[i] ?? 0) * 0.55;
      break;
    }
    case "fm_bass":
      v = fmBass(hz, len);
      break;
    case "slap":
      v = slapBass(hz, len, rand);
      break;
    case "pluck_bass": {
      const p = lowpass(pluck(hz, len + 0.25, rand, 0.35), 1400);
      const sub = subBass(hz, len, { drive: 1 });
      v = new Float32Array(Math.max(p.length, sub.length));
      for (let i = 0; i < v.length; i++) v[i] = (p[i] ?? 0) * 0.8 + (sub[i] ?? 0) * 0.35;
      break;
    }
    // harmony
    case "pad":
      v = chordSum(note.midi, (f) =>
        sawVoice(f, len, { voices: 3, detune: 0.009, cutoff: 1500, a: 0.35, d: 0.5, s: 0.85, r: 0.6 }),
      );
      break;
    case "strings":
      v = chordSum(note.midi, (f) => strings(f, len));
      break;
    case "strings_stacc":
      v = chordSum(note.midi, (f) => strings(f, len, { attack: 0.012, bright: 0.65 }));
      break;
    case "stab":
      v = chordSum(note.midi, (f) =>
        sawVoice(f, len, {
          voices: 3,
          detune: 0.011,
          cutoff: 1100,
          cutoffEnv: 2600,
          a: 0.003,
          d: 0.3,
          s: 0.45,
          r: 0.35,
        }),
      );
      break;
    case "rhodes":
      v = chordSum(note.midi, (f) => keys(f, len, 0.32));
      break;
    case "organ":
      v = chordSum(note.midi, (f) => organ(f, len));
      break;
    case "piano":
      v = chordSum(note.midi, (f) => piano(f, len, rand));
      break;
    case "guitar":
      v = guitarStrum(
        note.midi.map((m) => midiHz(m)),
        Math.max(0.3, len),
        rand,
        { down: note.variant === 0 },
      );
      break;
    case "guitar_chop":
      v = chordSum(note.midi, (f) => mutedGuitar(f, rand));
      break;
    // top
    case "pluck":
      v = chordSum(note.midi, (f) =>
        sawVoice(f, len, {
          voices: 2,
          detune: 0.006,
          cutoff: 900,
          cutoffEnv: 4200,
          a: 0.002,
          d: 0.12,
          s: 0.25,
          r: 0.08,
        }),
      );
      break;
    case "arp_saw":
      v = chordSum(note.midi, (f) =>
        sawVoice(f, len, {
          voices: 2,
          detune: 0.005,
          cutoff: 2400,
          cutoffEnv: 2600,
          a: 0.002,
          d: 0.08,
          s: 0.3,
          r: 0.05,
        }),
      );
      break;
    case "bell":
      v = chordSum(note.midi, (f) => bell(f, Math.max(1.2, len)));
      break;
    case "glock":
      v = chordSum(note.midi, (f) => mallet(f, "glock", 1.2));
      break;
    case "marimba":
      v = chordSum(note.midi, (f) => mallet(f, "marimba", 0.7));
      break;
    case "brass":
      v = chordSum(note.midi, (f) => brass(f, len));
      break;
    default:
      throw new Error(`music: unknown instrument ${note.inst}`);
  }
  cache.set(key, v);
  return v;
}

/** per-instrument level so every voice sits at a sensible level before the lane gain */
const INST_GAIN: Record<string, number> = {
  kick: 0.95,
  kick_soft: 0.95,
  kick_hard: 0.9,
  snare: 0.55,
  clap: 0.8,
  hat: 0.7,
  open_hat: 0.6,
  shaker: 0.8,
  rim: 0.7,
  metal: 0.7,
  tom: 0.8,
  taiko: 0.9,
  ride: 0.6,
  crash: 0.55,
  boom: 0.9,
  riser: 0.7,
  reverse_cymbal: 0.7,
  vinyl: 1,
  drone: 0.6,
  sub: 0.85,
  saw_bass: 0.8,
  fm_bass: 0.8,
  slap: 0.85,
  pluck_bass: 0.9,
  pad: 0.75,
  strings: 0.8,
  strings_stacc: 0.75,
  stab: 0.7,
  rhodes: 0.55,
  organ: 0.6,
  piano: 0.7,
  guitar: 0.5,
  guitar_chop: 0.8,
  pluck: 0.6,
  arp_saw: 0.5,
  bell: 0.45,
  glock: 0.5,
  marimba: 0.6,
  brass: 0.55,
};

/** low-pass cutoff (Hz) for an energy 0..1: 2 kHz at 0, 8 kHz at 0.5, open above ~0.8 (× mood brightness) */
export function energyCutoff(e: number, brightness = 1): number {
  return Math.min(18_000, Math.max(600, 2000 * 2 ** (4 * e) * brightness));
}

/** active level of the drum bus before mastering (dBFS); the other buses are set relative to it */
const MIX_REF_DB = -12;
/** loudest 50 ms window of the riser / swell bus and of the accent (drop, final hit) bus */
const FX_PEAK_DB = -13;
const HIT_PEAK_DB = -7;

const WIN = Math.round(0.05 * SR);

function windowPowers(bus: Stereo): number[] {
  const out: number[] = [];
  for (let s = 0; s + WIN <= bus.l.length; s += WIN) {
    let acc = 0;
    for (let i = s; i < s + WIN; i++) acc += (bus.l[i]! ** 2 + bus.r[i]! ** 2) / 2;
    out.push(acc / WIN);
  }
  return out;
}

/** RMS over the windows where the bus plays (within 30 dB of its loudest window) */
function activeLevel(bus: Stereo): number {
  const p = windowPowers(bus);
  const max = Math.max(0, ...p);
  const active = p.filter((v) => v > max * 1e-3);
  return active.length ? Math.sqrt(active.reduce((s, v) => s + v, 0) / active.length) : 0;
}

function maxWindowLevel(bus: Stereo): number {
  return Math.sqrt(Math.max(0, ...windowPowers(bus)));
}

function scaleStereo(bus: Stereo, g: number): void {
  if (g === 1) return;
  for (const ch of [bus.l, bus.r]) for (let i = 0; i < ch.length; i++) ch[i] = ch[i]! * g;
}

/** level of the groove at an energy 0..1 (dB): −7 dB at 0, 0 dB at 1 */
export function energyLevelDb(e: number): number {
  return -7 * (1 - e);
}

export interface RenderedMusic {
  audio: Stereo;
  arrangement: Arrangement;
  /** master peak (linear) */
  peak: number;
  renderMs: number;
}

export function renderMusic(intent: MusicIntent): RenderedMusic {
  return renderArrangement(arrange(intent));
}

/** render an arrangement; `master: false` skips levelling / limiting (stems, diagnostics) */
export function renderArrangement(arr: Arrangement, opts: { master?: boolean } = {}): RenderedMusic {
  const t0 = Date.now();
  const n = arr.samples;
  const rand = prng(arr.seed ^ 0x5bd1e995);
  const buses: Record<Bus, Stereo> = {
    drums: stereo(n),
    bass: stereo(n),
    harmony: stereo(n),
    pad: stereo(n),
    top: stereo(n),
    texture: stereo(n),
    fx: stereo(n),
    hit: stereo(n),
  };
  for (const note of arr.notes) {
    if (note.at >= n) continue;
    addMono(
      buses[note.bus],
      voice(arr, note, rand),
      note.at,
      note.vel * (INST_GAIN[note.inst] ?? 0.7),
      note.pan,
    );
  }
  const { style, harmony } = arr;

  // mix by targets: every bus is set to its genre level (active RMS), accents to their peak-window level
  const scale = Object.fromEntries(Object.keys(buses).map((b) => [b, 1])) as Record<Bus, number>;
  for (const b of ["drums", "bass", "harmony", "pad", "top", "texture"] as const) {
    const level = activeLevel(buses[b]);
    if (level > 1e-7) scale[b] = dbGain(MIX_REF_DB + style.mix[b]) / level;
  }
  for (const [b, target] of [
    ["fx", FX_PEAK_DB],
    ["hit", HIT_PEAK_DB],
  ] as const) {
    const level = maxWindowLevel(buses[b]);
    if (level > 1e-7) scale[b] = dbGain(target) / level;
  }
  for (const b of Object.keys(buses) as Bus[]) scaleStereo(buses[b], scale[b]);
  // reverb sends follow the bus levels (voices are cached, so this pass only mixes)
  const grooveSend = stereo(n);
  const hitSend = stereo(n);
  for (const note of arr.notes) {
    if (note.at >= n || note.send <= 0) continue;
    const g = note.vel * (INST_GAIN[note.inst] ?? 0.7) * scale[note.bus] * note.send;
    addMono(
      note.bus === "hit" || note.bus === "fx" ? hitSend : grooveSend,
      voice(arr, note, rand),
      note.at,
      g,
      note.pan,
    );
  }

  // sidechain pump on everything tonal in the groove
  if (style.pumpDb > 0) {
    const curve = duckCurve(n, arr.kicks, style.pumpDb, 4, (60_000 / arr.bpm) * 0.45);
    for (const b of ["bass", "harmony", "pad", "top"] as const) applyGainCurve(buses[b], curve);
  }

  // groove sum
  const groove = stereo(n);
  for (const b of ["drums", "bass", "harmony", "pad", "top", "texture"] as const)
    for (let i = 0; i < n; i++) {
      groove.l[i]! += buses[b].l[i]!;
      groove.r[i]! += buses[b].r[i]!;
    }
  if (style.top?.delayBeats) {
    const echo = pingPongDelay(buses.top, arr.beatSamples * style.top.delayBeats, 0.38, 3800);
    for (let i = 0; i < n; i++) {
      groove.l[i]! += echo.l[i]! * 0.32;
      groove.r[i]! += echo.r[i]! * 0.32;
    }
  }
  const wet = reverb(grooveSend, {
    room: style.reverb.room,
    damp: style.reverb.damp,
    width: 1,
    preDelayMs: 18,
  });
  for (let i = 0; i < n; i++) {
    groove.l[i]! += wet.l[i]!;
    groove.r[i]! += wet.r[i]!;
  }
  if (style.drive > 0) for (const ch of [groove.l, groove.r]) saturate(ch, style.drive);
  if (style.tape) for (const ch of [groove.l, groove.r]) saturate(biquad(ch, "lowpass", 9500, 0.6), 1.25);

  // energy automation: per-32-sample energy table drives the tone and the level of the groove
  const block = 32;
  const energy = new Float32Array(Math.ceil(n / block) + 1);
  for (let b = 0; b < energy.length; b++) energy[b] = arr.energyAt((b * block * 1000) / SR);
  const eAt = (i: number) => energy[Math.floor(i / block)]!;
  const risers = arr.events.risers.map((r) => ({ s: (r.startMs * SR) / 1000, e: (r.endMs * SR) / 1000 }));
  const hpAt = (i: number) => {
    for (const r of risers) if (i >= r.s && i < r.e) return 20 + 360 * ((i - r.s) / (r.e - r.s)) ** 2;
    return 20;
  };
  for (const ch of [groove.l, groove.r]) {
    if (risers.length) svf(ch, "hp", hpAt, 0.1, block);
    svf(ch, "lp", (i) => energyCutoff(eAt(i), harmony.brightness), 0.12, block);
    biquad(ch, "highpass", 28);
    for (let i = 0; i < n; i++) ch[i] = ch[i]! * dbGain(energyLevelDb(eAt(i)));
  }

  // accents, unfiltered, with their own (longer) reverb
  const hitWet = reverb(hitSend, {
    room: Math.max(0.8, style.reverb.room),
    damp: 0.35,
    width: 1,
    preDelayMs: 12,
  });
  const out = stereo(n);
  for (let i = 0; i < n; i++) {
    out.l[i] = groove.l[i]! + buses.fx.l[i]! + buses.hit.l[i]! + hitWet.l[i]!;
    out.r[i] = groove.r[i]! + buses.fx.r[i]! + buses.hit.r[i]! + hitWet.r[i]!;
  }

  if (opts.master !== false) master(out, arr);
  return { audio: out, arrangement: arr, peak: peak(out), renderMs: Date.now() - t0 };
}

/** stop gate, edge fades, tone, level and limiting — leaves the peak at or below MUSIC_CEILING_DB */
function master(out: Stereo, arr: Arrangement): void {
  const n = out.l.length;
  for (const ch of [out.l, out.r]) {
    biquad(ch, "lowpass", 16_500);
    biquad(ch, "lowpass", 16_500);
    biquad(ch, "highpass", 25);
  }
  // level: the loud part of the bed (90th percentile of 400 ms windows) at −14 dBFS RMS
  const win = Math.round(0.4 * SR);
  const levels: number[] = [];
  for (let s = 0; s + win <= n; s += win) {
    let acc = 0;
    for (let i = s; i < s + win; i++) acc += (out.l[i]! ** 2 + out.r[i]! ** 2) / 2;
    levels.push(Math.sqrt(acc / win));
  }
  levels.sort((a, b) => a - b);
  const ref = levels.length ? levels[Math.min(levels.length - 1, Math.floor(levels.length * 0.9))]! : 0;
  if (ref > 1e-6) {
    const g = dbGain(-14) / ref;
    for (const ch of [out.l, out.r]) for (let i = 0; i < n; i++) ch[i] = ch[i]! * g;
  }
  const ceiling = dbGain(MUSIC_CEILING_DB);
  limit(out, ceiling * 0.97, 5, 80);
  // stop: everything ends at the stop time (15 ms release); otherwise a 30 ms fade on the last samples
  const stop = arr.events.stopMs !== undefined ? Math.round((arr.events.stopMs * SR) / 1000) : n;
  const rel = Math.min(stop, Math.round((stop < n ? 0.015 : 0.03) * SR));
  const fadeIn = Math.min(n, Math.round(0.003 * SR));
  for (const ch of [out.l, out.r]) {
    for (let i = 0; i < fadeIn; i++) ch[i] = ch[i]! * (i / fadeIn);
    for (let i = stop - rel; i < n; i++) ch[i] = i >= stop ? 0 : ch[i]! * ((stop - i) / rel);
  }
  const p = peak(out);
  if (p > ceiling)
    for (const ch of [out.l, out.r]) for (let i = 0; i < n; i++) ch[i] = (ch[i]! * ceiling) / p;
}
