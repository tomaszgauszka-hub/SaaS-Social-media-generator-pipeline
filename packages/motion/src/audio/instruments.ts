import { biquad, pinkNoise, reversed, saturate, svf, whiteNoise } from "./dsp.ts";
import { SR, adsr, bandpass, highpass, lowpass, pluck } from "./synth.ts";

/**
 * Second instrument set for genre-specific arrangements (reel sales beds): sub / FM / slap bass, drawbar organ,
 * string ensemble, brass, strummed and muted guitar, piano, mallets, toms, metallic percussion, rim, cymbals,
 * booms, risers and vinyl texture. Same conventions as synth.ts: mono Float32 at SR, peak ≈ 1, deterministic
 * (noise only from the caller's seeded PRNG), envelopes end at zero (no clicks).
 */

const TAU = 2 * Math.PI;
const len = (seconds: number) => Math.max(1, Math.round(SR * seconds));

/** release tail appended after the gate */
function tailFor(release: number): number {
  return release * 5;
}

/** sine sub bass with soft saturation (the 2nd/3rd harmonics keep it audible on phone speakers) */
export function subBass(
  hz: number,
  seconds: number,
  opts: { drive?: number; glideFromHz?: number; release?: number } = {},
): Float32Array {
  const r = opts.release ?? 0.05;
  const n = len(seconds + tailFor(r));
  const out = new Float32Array(n);
  const drive = opts.drive ?? 1.6;
  const norm = Math.tanh(drive);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = opts.glideFromHz ? hz + (opts.glideFromHz - hz) * Math.exp(-t / 0.03) : hz;
    ph += (TAU * f) / SR;
    out[i] = (Math.tanh(Math.sin(ph) * drive) / norm) * adsr(i, 0.004, 0.08, 0.85, r, seconds);
  }
  return out;
}

/** two-operator FM bass (metallic / growly: industrial, minimal tech) */
export function fmBass(
  hz: number,
  seconds: number,
  opts: { ratio?: number; index?: number; decay?: number } = {},
): Float32Array {
  const n = len(seconds + 0.2);
  const out = new Float32Array(n);
  const ratio = opts.ratio ?? 1;
  const index = opts.index ?? 2.4;
  const decay = opts.decay ?? 0.12;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const mod = Math.sin(TAU * hz * ratio * t) * index * (0.25 + Math.exp(-t / decay));
    out[i] =
      (Math.sin(TAU * hz * t + mod) * 0.7 + Math.sin(TAU * hz * 0.5 * t) * 0.45) *
      adsr(i, 0.003, 0.15, 0.7, 0.04, seconds);
  }
  return lowpass(out, 2400);
}

/** slap bass: bright string pluck + sine body + thumb "pop" (funk) */
export function slapBass(hz: number, seconds: number, rand: () => number): Float32Array {
  const n = len(seconds + 0.15);
  const string = pluck(hz, seconds + 0.15, rand, 0.9);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const gate = adsr(i, 0.002, 0.25, 0.55, 0.05, seconds);
    out[i] =
      (string[i]! * 0.55 + Math.sin(TAU * hz * t) * 0.6 * Math.exp(-t / 0.4)) * gate +
      Math.sin(TAU * hz * 4 * t) * 0.35 * Math.exp(-t / 0.012);
  }
  return lowpass(out, 3200);
}

/** drawbar organ (16' 8' 5⅓' 4' style harmonics) with percussive decay and key click — the house "organ stab" */
export function organ(
  hz: number,
  seconds: number,
  drawbars: readonly number[] = [1, 0.7, 0.45, 0.3],
): Float32Array {
  const n = len(seconds + 0.25);
  const out = new Float32Array(n);
  const harmonics = [1, 2, 3, 4, 6];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let h = 0; h < drawbars.length && h < harmonics.length; h++)
      v += Math.sin(TAU * hz * harmonics[h]! * t) * drawbars[h]!;
    const env = adsr(i, 0.002, 0.22, 0.35, 0.05, seconds);
    out[i] = (v / 2.2) * env + (i < 120 ? Math.sin(TAU * 2400 * t) * 0.15 * (1 - i / 120) : 0);
  }
  return out;
}

/** string ensemble: 4 detuned saws with vibrato and slow bow attack (cinematic, elegant) */
export function strings(
  hz: number,
  seconds: number,
  opts: { attack?: number; bright?: number } = {},
): Float32Array {
  const a = opts.attack ?? 0.35;
  const r = 0.45;
  const n = len(seconds + tailFor(r) * 0.6);
  const out = new Float32Array(n);
  const detune = [-0.006, -0.002, 0.003, 0.007];
  const phases = [0.11, 0.53, 0.27, 0.79];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const vib = 1 + 0.0028 * Math.sin(TAU * 5.3 * t) * Math.min(1, t / 0.6);
    let v = 0;
    for (let k = 0; k < 4; k++) {
      phases[k] = (phases[k]! + (hz * (1 + detune[k]!) * vib) / SR) % 1;
      v += phases[k]! * 2 - 1;
    }
    out[i] = (v / 4) * adsr(i, a, 0.3, 0.85, r, seconds);
  }
  svf(out, "lp", 1800 + 2600 * (opts.bright ?? 0.5), 0.1);
  return biquad(out, "highpass", 90);
}

/** brass stab: saw with a pitch scoop and an opening filter envelope (funk horns, cinematic accents) */
export function brass(hz: number, seconds: number): Float32Array {
  const n = len(seconds + 0.3);
  const raw = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = hz * 2 ** ((-0.9 * Math.exp(-t / 0.02)) / 12);
    ph = (ph + f / SR) % 1;
    raw[i] = (ph * 2 - 1) * adsr(i, 0.012, 0.18, 0.75, 0.06, seconds);
  }
  return svf(raw, "lp", (i) => 700 + 3200 * Math.exp(-i / SR / 0.12) + 900, 0.25);
}

/**
 * Strummed chord: one Karplus-Strong string per note, offset by `spreadMs` (down-strum low → high, up-strum
 * high → low), through a small guitar-body EQ.
 */
export function guitarStrum(
  hzs: readonly number[],
  seconds: number,
  rand: () => number,
  opts: { down?: boolean; spreadMs?: number; brightness?: number } = {},
): Float32Array {
  const spread = Math.round(((opts.spreadMs ?? 11) * SR) / 1000);
  const order = opts.down === false ? [...hzs].reverse() : [...hzs];
  const n = len(seconds) + spread * order.length;
  const out = new Float32Array(n);
  order.forEach((hz, k) => {
    const s = pluck(hz, seconds, rand, opts.brightness ?? 0.6);
    const g = (opts.down === false ? 0.8 : 1) * (1 - k * 0.04);
    for (let i = 0; i < s.length && i + k * spread < n; i++) out[i + k * spread]! += s[i]! * g;
  });
  biquad(out, "peaking", 180, 1.1, 3);
  biquad(out, "peaking", 2600, 1.4, 2);
  return biquad(out, "highpass", 75);
}

/** palm-muted single note (funk chops, acoustic ghost strums) */
export function mutedGuitar(hz: number, rand: () => number): Float32Array {
  const s = pluck(hz, 0.14, rand, 0.75);
  for (let i = 0; i < s.length; i++) s[i] = s[i]! * Math.exp(-i / (SR * 0.035));
  return biquad(s, "highpass", 160);
}

/** piano: inharmonic partials with per-partial decay plus hammer noise */
export function piano(hz: number, seconds: number, rand: () => number): Float32Array {
  const r = 0.28;
  const n = len(seconds + r * 3);
  const out = new Float32Array(n);
  const B = 0.00035;
  const decay = 1.6 * (220 / hz) ** 0.35;
  const partials = Array.from({ length: 8 }, (_, k) => {
    const m = k + 1;
    return { f: hz * m * Math.sqrt(1 + B * m * m), a: 1 / m ** 1.25, d: decay / (1 + 0.45 * k) };
  });
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (const p of partials) if (p.f < SR * 0.45) v += Math.sin(TAU * p.f * t) * p.a * Math.exp(-t / p.d);
    const release = t > seconds ? Math.exp(-(t - seconds) / r) : 1;
    out[i] =
      v * 0.55 * release * Math.min(1, i / 24) + (i < 400 ? (rand() * 2 - 1) * 0.08 * (1 - i / 400) : 0);
  }
  return out;
}

/** mallet percussion: marimba (wood, 1 : 4 : 10) or glockenspiel (metal bar modes 1 : 2.76 : 5.40 : 8.93) */
export function mallet(hz: number, kind: "marimba" | "glock", seconds = 0.9): Float32Array {
  const n = len(seconds);
  const out = new Float32Array(n);
  const modes =
    kind === "marimba"
      ? [
          { r: 1, a: 1, d: 0.42 },
          { r: 3.93, a: 0.22, d: 0.08 },
          { r: 9.6, a: 0.08, d: 0.02 },
        ]
      : [
          { r: 1, a: 1, d: 0.8 },
          { r: 2.76, a: 0.35, d: 0.3 },
          { r: 5.4, a: 0.2, d: 0.12 },
          { r: 8.93, a: 0.1, d: 0.05 },
        ];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (const m of modes)
      if (hz * m.r < SR * 0.45) v += Math.sin(TAU * hz * m.r * t) * m.a * Math.exp(-t / m.d);
    out[i] = v * Math.min(1, i / 30) * (1 - i / n);
  }
  return out;
}

/** tuned tom / taiko: sine with a pitch drop plus a noise skin attack */
export function tom(hz: number, rand: () => number, decay = 0.32): Float32Array {
  const n = len(decay * 5);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (TAU * hz * (1 + 0.6 * Math.exp(-t / 0.04))) / SR;
    out[i] = Math.sin(ph) * Math.exp(-t / decay) + (rand() * 2 - 1) * 0.35 * Math.exp(-t / 0.012);
  }
  return lowpass(out, 3200);
}

/** inharmonic metallic hit (struck plate / pipe partial ratios) — industrial percussion */
export function metalPerc(rand: () => number, hz = 420, decay = 0.18): Float32Array {
  const n = len(decay * 5);
  const out = new Float32Array(n);
  const ratios = [1, 1.47, 2.09, 2.56, 3.91, 5.12];
  const phases = ratios.map(() => rand() * TAU);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    ratios.forEach((r, k) => {
      v +=
        (Math.sin(TAU * hz * r * t + phases[k]!) * Math.exp(-t / (decay / (1 + k * 0.35)))) / (1 + k * 0.3);
    });
    out[i] = v * 0.45 + (rand() * 2 - 1) * 0.5 * Math.exp(-t / 0.004);
  }
  return biquad(out, "highpass", 250);
}

/** rim shot / side stick */
export function rim(rand: () => number): Float32Array {
  const n = len(0.07);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] =
      Math.sin(TAU * 1720 * t) * Math.exp(-t / 0.008) * 0.6 +
      Math.sin(TAU * 480 * t) * Math.exp(-t / 0.012) * 0.5 +
      (rand() * 2 - 1) * Math.exp(-t / 0.002) * 0.6;
  }
  return biquad(out, "highpass", 300);
}

/** crash cymbal: bright noise with ringing metal partials, long decay */
export function crash(rand: () => number, seconds = 2.2): Float32Array {
  const n = len(seconds);
  const nz = biquad(whiteNoise(n, rand), "highpass", 2800, 0.6);
  const ring = metalPerc(rand, 3100, seconds * 0.25);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-t / (seconds * 0.28)) * Math.min(1, i / 60);
    out[i] = (nz[i]! * 0.8 + (ring[i] ?? 0) * 0.25) * env;
  }
  return biquad(out, "highshelf", 9000, 0.7, -3);
}

/** ride cymbal: bell ping + soft wash */
export function ride(rand: () => number): Float32Array {
  const n = len(0.7);
  const nz = biquad(whiteNoise(n, rand), "highpass", 5000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] =
      nz[i]! * 0.35 * Math.exp(-t / 0.25) +
      (Math.sin(TAU * 3400 * t) + 0.6 * Math.sin(TAU * 5120 * t)) * 0.12 * Math.exp(-t / 0.18);
  }
  return out;
}

/** sub boom: long falling sine (drops, final hits, cinematic impacts) */
export function boom(seconds = 1.6, fromHz = 95, toHz = 34): Float32Array {
  const n = len(seconds);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (TAU * (toHz + (fromHz - toHz) * Math.exp(-t / 0.09))) / SR;
    out[i] = Math.sin(ph) * Math.exp(-t / (seconds * 0.38)) * Math.min(1, i / 48);
  }
  return saturate(out, 1.4);
}

/** reversed cymbal swell that peaks at its last sample (place it so it ENDS on the downbeat) */
export function reverseCymbal(rand: () => number, seconds: number): Float32Array {
  const c = crash(rand, Math.max(0.3, seconds * 1.15));
  const r = reversed(c).subarray(c.length - len(seconds));
  const out = Float32Array.from(r);
  for (let i = 0; i < out.length; i++) out[i] = out[i]! * (i / out.length) ** 0.6;
  return out;
}

/** noise + saw riser that builds over `seconds` and peaks at the end */
export function noiseRiser(
  seconds: number,
  rand: () => number,
  opts: { fromHz?: number; toHz?: number } = {},
): Float32Array {
  const n = len(seconds);
  const from = opts.fromHz ?? 300;
  const to = opts.toHz ?? 6500;
  const nz = svf(pinkNoise(n, rand), "bp", (i) => from + (to - from) * (i / n) ** 2, 0.55);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const p = i / n;
    ph = (ph + (110 * 2 ** (p * 2.5)) / SR) % 1;
    const trem = 1 - 0.25 * (0.5 + 0.5 * Math.sin(TAU * (4 + 12 * p * p) * (i / SR)));
    out[i] = (nz[i]! * 2.2 + (ph * 2 - 1) * 0.12) * p ** 1.8 * trem;
  }
  return highpass(out, 120);
}

/** sparse vinyl crackle and hiss (lo-fi texture) */
export function vinylCrackle(n: number, rand: () => number, density = 12): Float32Array {
  const out = biquad(pinkNoise(n, rand), "bandpass", 3500, 0.5);
  for (let i = 0; i < n; i++) out[i] = out[i]! * 0.05;
  const pops = Math.round((n / SR) * density);
  for (let k = 0; k < pops; k++) {
    const at = Math.floor(rand() * n);
    const amp = 0.15 + rand() * 0.45;
    const w = 20 + Math.floor(rand() * 60);
    for (let i = 0; i < w && at + i < n; i++) out[at + i]! += (rand() * 2 - 1) * amp * (1 - i / w);
  }
  return highpass(out, 600);
}

/** slowly breathing drone (ambient beds): detuned sines + filtered noise air */
export function drone(hz: number, seconds: number, rand: () => number): Float32Array {
  const n = len(seconds);
  const air = bandpass(pinkNoise(n, rand), hz * 8, 1.5);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const lfo = 0.75 + 0.25 * Math.sin(TAU * 0.13 * t);
    out[i] =
      (Math.sin(TAU * hz * t) * 0.5 +
        Math.sin(TAU * hz * 1.003 * t) * 0.35 +
        Math.sin(TAU * hz * 2.0 * t) * 0.15 +
        air[i]! * 0.25) *
      lfo *
      Math.min(1, t / 0.8) *
      Math.min(1, (seconds - t) / 0.8);
  }
  return out;
}
