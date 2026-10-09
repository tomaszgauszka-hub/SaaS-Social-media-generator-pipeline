import { SR, type Stereo } from "./synth.ts";

/**
 * Mixing / effects primitives on top of synth.ts: RBJ biquads (fixed and swept), a zero-delay-feedback
 * state-variable filter that stays stable under fast modulation (energy-automated tone, riser sweeps), Freeverb,
 * a tempo-synced ping-pong delay, sidechain ("pump") gain curves and a few buffer helpers. Everything works in
 * place on Float32 buffers at SR and is deterministic.
 */

export type BiquadType = "lowpass" | "highpass" | "bandpass" | "peaking" | "lowshelf" | "highshelf";

interface Coeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** RBJ cookbook coefficients (normalised by a0) */
export function biquadCoeffs(type: BiquadType, fc: number, q = Math.SQRT1_2, gainDb = 0): Coeffs {
  const w0 = (2 * Math.PI * Math.min(Math.max(fc, 10), SR * 0.49)) / SR;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const A = 10 ** (gainDb / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (type) {
    case "lowpass":
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case "highpass":
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case "bandpass":
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case "peaking":
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
      break;
    case "lowshelf": {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + s);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - s);
      a0 = A + 1 + (A - 1) * cos + s;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - s;
      break;
    }
    case "highshelf": {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + s);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - s);
      a0 = A + 1 - (A - 1) * cos + s;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - s;
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** fixed biquad in place (Direct Form I) */
export function biquad(
  buf: Float32Array,
  type: BiquadType,
  fc: number,
  q = Math.SQRT1_2,
  gainDb = 0,
): Float32Array {
  const { b0, b1, b2, a1, a2 } = biquadCoeffs(type, fc, q, gainDb);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i]!;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    buf[i] = y;
  }
  return buf;
}

export type SvfMode = "lp" | "hp" | "bp";

/**
 * Zero-delay-feedback state-variable filter (Zavalishin / Simper "TPT" form). `fc` may be a function of the
 * sample index; it is evaluated every `block` samples. `res` 0 (no resonance) … 0.95 (sharp peak).
 */
export function svf(
  buf: Float32Array,
  mode: SvfMode,
  fc: number | ((i: number) => number),
  res = 0,
  block = 16,
): Float32Array {
  const k = 2 - 2 * Math.min(0.97, Math.max(0, res));
  let ic1 = 0;
  let ic2 = 0;
  let a1 = 0;
  let a2 = 0;
  let a3 = 0;
  const update = (f: number) => {
    const g = Math.tan((Math.PI * Math.min(Math.max(f, 10), SR * 0.45)) / SR);
    a1 = 1 / (1 + g * (g + k));
    a2 = g * a1;
    a3 = g * a2;
  };
  if (typeof fc === "number") update(fc);
  for (let i = 0; i < buf.length; i++) {
    if (typeof fc !== "number" && i % block === 0) update(fc(i));
    const x = buf[i]!;
    const v3 = x - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    buf[i] = mode === "lp" ? v2 : mode === "bp" ? v1 : x - k * v1 - v2;
  }
  return buf;
}

/* ------------------------------------------------------------------ reverb / delay -------------- */

export interface ReverbOptions {
  /** 0..1 decay length */
  room: number;
  /** 0..1 high-frequency damping */
  damp: number;
  /** 0..1 stereo width */
  width?: number;
  preDelayMs?: number;
}

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const SPREAD = 23;

/**
 * Freeverb (Jezar's public-domain design, tunings scaled to 48 kHz). Returns the WET signal only, same length
 * as the input; the caller mixes it back at the send level it wants.
 */
export function reverb(input: Stereo, opts: ReverbOptions): Stereo {
  const n = input.l.length;
  const scale = SR / 44_100;
  const feedback = 0.7 + 0.28 * Math.min(1, Math.max(0, opts.room));
  const damp = 0.4 * Math.min(1, Math.max(0, opts.damp));
  const width = opts.width ?? 1;
  const wet1 = width / 2 + 0.5;
  const wet2 = (1 - width) / 2;
  const pre = Math.round(((opts.preDelayMs ?? 0) * SR) / 1000);
  const out: Stereo = { l: new Float32Array(n), r: new Float32Array(n) };
  const channel = (spread: number) => {
    const combs = COMBS.map((d) => ({
      buf: new Float32Array(Math.round((d + spread) * scale)),
      idx: 0,
      store: 0,
    }));
    const aps = ALLPASSES.map((d) => ({ buf: new Float32Array(Math.round((d + spread) * scale)), idx: 0 }));
    const res = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = i - pre;
      const x = j >= 0 ? (input.l[j]! + input.r[j]!) * 0.015 : 0;
      let acc = 0;
      for (const c of combs) {
        const y = c.buf[c.idx]!;
        c.store = y * (1 - damp) + c.store * damp;
        c.buf[c.idx] = x + c.store * feedback;
        if (++c.idx >= c.buf.length) c.idx = 0;
        acc += y;
      }
      for (const a of aps) {
        const b = a.buf[a.idx]!;
        a.buf[a.idx] = acc + b * 0.5;
        if (++a.idx >= a.buf.length) a.idx = 0;
        acc = b - acc;
      }
      res[i] = acc;
    }
    return res;
  };
  const l = channel(0);
  const r = channel(SPREAD);
  for (let i = 0; i < n; i++) {
    out.l[i] = l[i]! * wet1 + r[i]! * wet2;
    out.r[i] = r[i]! * wet1 + l[i]! * wet2;
  }
  return out;
}

/**
 * Ping-pong delay (wet only): left repeats at `delaySamples`, then right, … each repeat low-passed at
 * `toneHz` and scaled by `feedback`.
 */
export function pingPongDelay(input: Stereo, delaySamples: number, feedback: number, toneHz = 4000): Stereo {
  const n = input.l.length;
  const d = Math.max(1, Math.round(delaySamples));
  const out: Stereo = { l: new Float32Array(n), r: new Float32Array(n) };
  const a = 1 - Math.exp((-2 * Math.PI * toneHz) / SR);
  const lineL = new Float32Array(d);
  const lineR = new Float32Array(d);
  let lpL = 0;
  let lpR = 0;
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const yl = lineL[idx]!;
    const yr = lineR[idx]!;
    out.l[i] = yl;
    out.r[i] = yr;
    // the input enters the left line, every echo crosses to the other side scaled by the feedback
    lpL += a * ((input.l[i]! + input.r[i]!) * 0.5 + yr * feedback - lpL);
    lpR += a * (yl * feedback - lpR);
    lineL[idx] = lpL;
    lineR[idx] = lpR;
    if (++idx >= d) idx = 0;
  }
  return out;
}

/* ------------------------------------------------------------------ dynamics / utilities --------- */

/**
 * Sidechain gain curve: at every trigger (sample index, sorted) the gain dips by `depthDb` within `attackMs`
 * and recovers exponentially with `releaseMs` — the "pump" of house music, without a real compressor.
 */
export function duckCurve(
  n: number,
  triggers: readonly number[],
  depthDb: number,
  attackMs = 4,
  releaseMs = 120,
): Float32Array {
  const out = new Float32Array(n).fill(1);
  if (depthDb <= 0 || !triggers.length) return out;
  const att = Math.max(1, (attackMs * SR) / 1000);
  const rel = Math.max(1, (releaseMs * SR) / 1000);
  const sorted = [...triggers].sort((a, b) => a - b);
  let k = -1;
  for (let i = 0; i < n; i++) {
    while (k + 1 < sorted.length && sorted[k + 1]! <= i) k++;
    if (k < 0) continue;
    const d = i - sorted[k]!;
    const e = d < att ? d / att : Math.exp(-(d - att) / rel);
    out[i] = 10 ** ((-depthDb * e) / 20);
  }
  return out;
}

/** tanh saturation normalised so that ±1 stays ±1 */
export function saturate(buf: Float32Array, drive: number): Float32Array {
  if (drive <= 1e-3) return buf;
  const norm = Math.tanh(drive);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i]! * drive) / norm;
  return buf;
}

export function whiteNoise(n: number, rand: () => number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rand() * 2 - 1;
  return out;
}

/** pink noise (Paul Kellet's economy filter), roughly unit RMS */
export function pinkNoise(n: number, rand: () => number): Float32Array {
  const out = new Float32Array(n);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = rand() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
  }
  return out;
}

/** add `src` × gain into `dst` at `start` (samples), clipped to both buffers */
export function mixInto(dst: Float32Array, src: Float32Array, start: number, gain = 1): void {
  const s0 = Math.max(0, start);
  const off = s0 - start;
  const n = Math.min(src.length - off, dst.length - s0);
  for (let i = 0; i < n; i++) dst[s0 + i]! += src[off + i]! * gain;
}

/** linear fade-in / fade-out of the buffer edges (samples) */
export function fadeEdges(buf: Float32Array, inSamples: number, outSamples: number): Float32Array {
  const n = buf.length;
  const fi = Math.min(n, Math.max(0, Math.round(inSamples)));
  const fo = Math.min(n, Math.max(0, Math.round(outSamples)));
  for (let i = 0; i < fi; i++) buf[i] = buf[i]! * (i / fi);
  for (let i = 0; i < fo; i++) buf[n - 1 - i] = buf[n - 1 - i]! * (i / fo);
  return buf;
}

export function reversed(buf: Float32Array): Float32Array {
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[buf.length - 1 - i]!;
  return out;
}

/** multiply both channels by a gain curve (same length or shorter: the rest is left as is) */
export function applyGainCurve(bus: Stereo, curve: Float32Array): void {
  const n = Math.min(curve.length, bus.l.length);
  for (let i = 0; i < n; i++) {
    bus.l[i] = bus.l[i]! * curve[i]!;
    bus.r[i] = bus.r[i]! * curve[i]!;
  }
}

/** scale a buffer so its absolute peak is `target` (no-op for silence) */
export function normalizePeak(buf: Float32Array, target: number): Float32Array {
  let p = 0;
  for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]!));
  if (p < 1e-9) return buf;
  const g = target / p;
  for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! * g;
  return buf;
}
