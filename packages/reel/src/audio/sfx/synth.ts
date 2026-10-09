import type { SfxKind } from "../../contracts/ids.ts";
import {
  SR,
  bell,
  biquad,
  boom,
  fadeEdges,
  kick,
  metalPerc,
  midiHz,
  noiseRiser,
  panGains,
  pinkNoise,
  reverb,
  reversed,
  saturate,
  svf,
  whiteNoise,
  type Stereo,
} from "../synth.ts";

/**
 * Procedural sound design for every SfxKind (48 kHz stereo, deterministic for a seed). Each recipe is a small
 * physical / studio idea — a band-passed air sweep, a struck plate's inharmonic modes, a rocker switch's two
 * contacts, a motor spinning up — so the kinds are clearly distinct and fit product footage. Every sound is
 * peak-normalised to SFX_PEAK_DB, so the plan's per-cue gain is the only level decision.
 *
 * `leadMs` is where the sound "lands": a whoosh / transition peaks there and a riser arrives there, so the cue
 * file is started that much earlier; for hits and clicks it is 0 (the onset is the cue).
 */

export const LOCAL_SFX_VERSION = "local-sfx/1";
export const SFX_PEAK_DB = -3;

export interface SfxSound {
  audio: Stereo;
  leadMs: number;
}

/** default and allowed length per kind (ms); clicks and hits have a fixed length */
export const SFX_LENGTH_MS: Record<SfxKind, { default: number; min: number; max: number }> = {
  whoosh: { default: 600, min: 250, max: 1500 },
  impact: { default: 1400, min: 1400, max: 1400 },
  metal_hit: { default: 1300, min: 1300, max: 1300 },
  metal_click: { default: 140, min: 140, max: 140 },
  mechanical_click: { default: 200, min: 200, max: 200 },
  motor: { default: 1300, min: 400, max: 4000 },
  snap: { default: 160, min: 160, max: 160 },
  air_release: { default: 850, min: 300, max: 2000 },
  electronic_beep: { default: 300, min: 300, max: 300 },
  transition: { default: 1000, min: 500, max: 2000 },
  riser: { default: 2000, min: 500, max: 6000 },
  bass_hit: { default: 1400, min: 1400, max: 1400 },
  ui_click: { default: 70, min: 70, max: 70 },
  shimmer: { default: 1700, min: 800, max: 3000 },
  light_switch: { default: 220, min: 220, max: 220 },
};

export function sfxLengthMs(kind: SfxKind, durationMs?: number): number {
  const l = SFX_LENGTH_MS[kind];
  return Math.round(Math.min(l.max, Math.max(l.min, durationMs ?? l.default)));
}

const TAU = 2 * Math.PI;

/** mono → stereo with a pan that may sweep from `pan[0]` to `pan[1]` */
function place(mono: Float32Array, pan: [number, number] = [0, 0]): Stereo {
  const n = mono.length;
  const out: Stereo = { l: new Float32Array(n), r: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    const [gl, gr] = panGains(pan[0] + (pan[1] - pan[0]) * (i / n));
    out.l[i] = mono[i]! * gl;
    out.r[i] = mono[i]! * gr;
  }
  return out;
}

/** add a reverb tail (wet × mix) in place */
function withRoom(s: Stereo, room: number, mix: number): Stereo {
  const wet = reverb(s, { room, damp: 0.45, width: 1, preDelayMs: 8 });
  for (let i = 0; i < s.l.length; i++) {
    s.l[i] = s.l[i]! + wet.l[i]! * mix;
    s.r[i] = s.r[i]! + wet.r[i]! * mix;
  }
  return s;
}

/** exponential decay envelope */
const dec = (i: number, s: number) => Math.exp(-i / (SR * s));

function sized(n: number, src: Float32Array): Float32Array {
  const out = new Float32Array(n);
  out.set(src.subarray(0, Math.min(n, src.length)));
  return out;
}

export function renderSfx(kind: SfxKind, rand: () => number, durationMs?: number): SfxSound {
  const ms = sfxLengthMs(kind, durationMs);
  const n = Math.round((ms * SR) / 1000);
  let s: Stereo;
  let leadMs = 0;
  switch (kind) {
    case "whoosh": {
      // band-passed air sweeping up then down, peaking at 60 %, panned across the frame
      const peakAt = 0.6;
      const nz = svf(
        pinkNoise(n, rand),
        "bp",
        (i) => {
          const p = i / n;
          return p < peakAt ? 350 + 3400 * (p / peakAt) ** 2 : 3750 - 2900 * ((p - peakAt) / (1 - peakAt));
        },
        0.45,
      );
      const body = biquad(pinkNoise(n, rand), "lowpass", 500);
      const m = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const p = i / n;
        const env = p < peakAt ? (p / peakAt) ** 2.2 : ((1 - p) / (1 - peakAt)) ** 1.4;
        m[i] = (nz[i]! * 2.2 + body[i]! * 0.5) * env;
      }
      s = place(m, [-0.7, 0.7]);
      leadMs = ms * peakAt;
      break;
    }
    case "impact": {
      // kick + sub boom + dark crash body, a little room
      const k = kick(1.6);
      const b = boom(1.2, 110, 38);
      const crashBody = biquad(whiteNoise(n, rand), "lowpass", 3000);
      const m = new Float32Array(n);
      for (let i = 0; i < n; i++)
        m[i] =
          (k[i] ?? 0) * 0.9 + (b[i] ?? 0) * 0.8 + crashBody[i]! * 0.55 * dec(i, 0.2) * Math.min(1, i / 30);
      s = withRoom(place(saturate(m, 1.3)), 0.75, 0.35);
      break;
    }
    case "metal_hit": {
      // two struck plates (inharmonic modes) + a sharp contact transient, ringing out in a room
      const hi = metalPerc(rand, 540, 0.42);
      const lo = metalPerc(rand, 205, 0.6);
      const m = new Float32Array(n);
      for (let i = 0; i < n; i++)
        m[i] = (hi[i] ?? 0) * 0.7 + (lo[i] ?? 0) * 0.8 + (rand() * 2 - 1) * dec(i, 0.003) * 0.8;
      s = withRoom(place(m, [0.1, -0.1]), 0.6, 0.3);
      break;
    }
    case "metal_click": {
      // a small latch: three high metal modes, 15 ms ring
      const m = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        m[i] =
          (Math.sin(TAU * 3230 * t) * 0.6 +
            Math.sin(TAU * 4710 * t) * 0.45 +
            Math.sin(TAU * 6930 * t) * 0.3) *
            dec(i, 0.015) +
          (rand() * 2 - 1) * dec(i, 0.0012) * 0.7;
      }
      s = place(biquad(m, "highpass", 1500));
      break;
    }
    case "mechanical_click": {
      // press + latch 38 ms later: plastic body resonance (420 Hz) under a 1.8 kHz contact
      const m = new Float32Array(n);
      const one = (at: number, g: number) => {
        const burst = svf(whiteNoise(Math.round(0.03 * SR), rand), "bp", 1800, 0.75);
        for (let i = 0; i < burst.length && at + i < n; i++) {
          const t = i / SR;
          m[at + i]! += (burst[i]! * 1.5 * dec(i, 0.004) + Math.sin(TAU * 420 * t) * dec(i, 0.02) * 0.6) * g;
        }
      };
      one(0, 1);
      one(Math.round(0.038 * SR), 0.75);
      s = place(m);
      break;
    }
    case "motor": {
      // electric motor spinning up: harmonic rotor tone + gear whine + brush noise, all rising with speed
      const m = new Float32Array(n);
      const brush = biquad(whiteNoise(n, rand), "bandpass", 2600, 0.8);
      let ph = 0;
      let phW = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const speed = 1 - Math.exp(-t / 0.35);
        const f = 55 + 105 * speed;
        ph += (TAU * f) / SR;
        phW += (TAU * f * 7) / SR;
        let rotor = 0;
        for (let k = 1; k <= 8; k++) rotor += Math.sin(ph * k) / k;
        const am = 0.8 + 0.2 * Math.sin(ph * 2);
        const env = Math.min(1, t / 0.04) * Math.min(1, (n - i) / (SR * 0.12));
        m[i] = (rotor * 0.35 * am + Math.sin(phW) * 0.18 * speed + brush[i]! * 0.5 * speed) * env;
      }
      s = place(biquad(m, "highpass", 60));
      break;
    }
    case "snap": {
      // sharp snap: very short bright crack + resonant 2.2 kHz body + a small low thump
      const crack = biquad(whiteNoise(n, rand), "highpass", 3000);
      const body = svf(whiteNoise(n, rand), "bp", 2200, 0.85);
      const m = new Float32Array(n);
      for (let i = 0; i < n; i++)
        m[i] =
          crack[i]! * dec(i, 0.0025) * 1.2 +
          body[i]! * dec(i, 0.022) * 1.6 +
          Math.sin((TAU * 180 * i) / SR) * dec(i, 0.03) * 0.35;
      s = withRoom(place(m), 0.35, 0.15);
      break;
    }
    case "air_release": {
      // pneumatic hiss: fast attack, band falling from 6 kHz to 2.8 kHz, a pop at the valve
      const nz = svf(whiteNoise(n, rand), "bp", (i) => 6000 - 3200 * (i / n), 0.25);
      const m = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const env =
          Math.min(1, t / 0.012) * Math.exp(-t / ((ms / 1000) * 0.45)) * Math.min(1, (n - i) / (SR * 0.05));
        m[i] = nz[i]! * 1.8 * env + Math.sin(TAU * 260 * t) * dec(i, 0.012) * 0.4;
      }
      s = place(biquad(m, "highpass", 900), [-0.2, 0.2]);
      break;
    }
    case "electronic_beep": {
      // two-tone confirmation beep (A6 → D7), soft square edge
      const m = new Float32Array(n);
      const tone = (from: number, len: number, hz: number) => {
        const a = Math.round(from * SR);
        const b = Math.round((from + len) * SR);
        const ramp = Math.round(0.004 * SR);
        for (let i = a; i < b && i < n; i++) {
          const t = (i - a) / SR;
          const env = Math.min(1, (i - a) / ramp, (b - i) / ramp);
          m[i] = (Math.sin(TAU * hz * t) + 0.18 * Math.sin(TAU * hz * 3 * t)) * env * 0.8;
        }
      };
      tone(0, 0.08, 1760);
      tone(0.1, 0.11, 2349.3);
      s = place(m);
      break;
    }
    case "transition": {
      // reverse swell + rising tonal sweep that lands on a soft sub thud at 78 %
      const land = 0.78;
      const a = Math.round(n * land);
      const swell = reversed(biquad(pinkNoise(a, rand), "lowpass", 5000));
      const m = new Float32Array(n);
      let ph = 0;
      for (let i = 0; i < a; i++) {
        const p = i / a;
        ph += (TAU * (180 + 1100 * p * p)) / SR;
        m[i] = (swell[i]! * dec(a - i, 0.18) * 1.4 + Math.sin(ph) * 0.25 * p ** 2) * p ** 1.5;
      }
      const thud = boom(Math.max(0.15, (n - a) / SR), 90, 45);
      for (let i = 0; i < thud.length && a + i < n; i++) m[a + i]! += thud[i]! * 0.7;
      s = withRoom(place(m, [0.6, -0.6]), 0.6, 0.25);
      leadMs = ms * land;
      break;
    }
    case "riser": {
      // noise build + a three-voice saw glide up an octave and a fifth, peaking at the end (the cue)
      const nz = noiseRiser(ms / 1000, rand);
      const m = new Float32Array(n);
      const ph = [0, 0.33, 0.66];
      for (let i = 0; i < n; i++) {
        const p = i / n;
        let v = 0;
        [1, 1.5, 2].forEach((r, k) => {
          ph[k] = (ph[k]! + (220 * r * 2 ** (p * 1.6)) / SR) % 1;
          v += ph[k] * 2 - 1;
        });
        m[i] = (nz[i] ?? 0) + v * 0.08 * p ** 2;
      }
      s = place(biquad(m, "highpass", 150), [-0.4, 0.4]);
      leadMs = ms;
      break;
    }
    case "bass_hit": {
      // 808-style sub drop with a click, driven
      const m = new Float32Array(n);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        ph += (TAU * (42 + 100 * Math.exp(-t / 0.05))) / SR;
        m[i] = Math.sin(ph) * dec(i, 0.42) * Math.min(1, i / 24) + (i < 96 ? (1 - i / 96) * 0.4 : 0);
      }
      s = place(saturate(m, 2.4));
      break;
    }
    case "ui_click": {
      // soft rounded interface tick
      const m = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        m[i] =
          Math.sin(TAU * 1250 * t) * dec(i, 0.006) * Math.min(1, i / 12) +
          (rand() * 2 - 1) * dec(i, 0.001) * 0.15;
      }
      s = place(m);
      break;
    }
    case "shimmer": {
      // staggered high bell cluster + airy sparkle, wide
      const m = new Float32Array(n);
      [88, 91, 95, 100, 103].forEach((note, k) => {
        const b = bell(midiHz(note), ms / 1000);
        const off = Math.round(SR * 0.055 * k);
        for (let i = 0; i + off < n && i < b.length; i++) m[i + off]! += b[i]! * (0.32 - k * 0.03);
      });
      const air = biquad(whiteNoise(n, rand), "highpass", 8000);
      for (let i = 0; i < n; i++) m[i]! += air[i]! * 0.08 * Math.sin((Math.PI * i) / n) ** 2;
      s = withRoom(place(m, [-0.5, 0.5]), 0.8, 0.45);
      break;
    }
    case "light_switch": {
      // rocker switch: spring tick, then the louder contact "clack" 9 ms later (650 Hz + 1.3 kHz body)
      const m = new Float32Array(n);
      const tick = biquad(whiteNoise(Math.round(0.006 * SR), rand), "highpass", 1500);
      for (let i = 0; i < tick.length; i++)
        m[i]! += tick[i]! * dec(i, 0.0015) * 0.6 + Math.sin((TAU * 3400 * i) / SR) * dec(i, 0.006) * 0.3;
      const at = Math.round(0.009 * SR);
      const clack = svf(whiteNoise(n - at, rand), "bp", 1300, 0.6);
      for (let i = 0; i < n - at; i++) {
        const t = i / SR;
        m[at + i]! +=
          Math.sin(TAU * 650 * t) * dec(i, 0.025) * 0.9 +
          clack[i]! * dec(i, 0.008) * 1.4 +
          Math.sin(TAU * 140 * t) * dec(i, 0.03) * 0.3;
      }
      s = withRoom(place(m), 0.3, 0.12);
      break;
    }
  }
  // exact length, click-free edges, normalised peak
  const out: Stereo = { l: sized(n, s.l), r: sized(n, s.r) };
  const tailMs = Math.min(25, ms * 0.15);
  for (const ch of [out.l, out.r]) fadeEdges(ch, 0, (tailMs * SR) / 1000);
  const p = Math.max(...[out.l, out.r].map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
  if (p > 1e-9) {
    const g = 10 ** (SFX_PEAK_DB / 20) / p;
    for (const ch of [out.l, out.r]) for (let i = 0; i < n; i++) ch[i] = ch[i]! * g;
  }
  return { audio: out, leadMs: Math.round(leadMs) };
}
