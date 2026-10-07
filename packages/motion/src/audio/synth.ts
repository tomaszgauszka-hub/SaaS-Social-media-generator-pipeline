/**
 * Deterministic DSP primitives for the AudioDirector (spec §36): oscillators, envelopes, filters and a few
 * instruments, rendered sample-by-sample into Float32 stereo buffers. No samples, no network, no randomness
 * beyond a seeded PRNG — the same plan always produces the same audio.
 */
export const SR = 48_000;

export interface Stereo {
  l: Float32Array;
  r: Float32Array;
}

export function stereo(samples: number): Stereo {
  return { l: new Float32Array(samples), r: new Float32Array(samples) };
}

/** mulberry32 */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);
export const dbGain = (db: number) => 10 ** (db / 20);

/** equal-power pan: -1 left … 1 right */
export function panGains(pan: number): [number, number] {
  const a = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

/** add a mono voice into the stereo bus at `start` (samples) */
export function addMono(bus: Stereo, src: Float32Array, start: number, gain: number, pan = 0): void {
  const [gl, gr] = panGains(pan);
  const s0 = Math.max(0, start);
  const n = Math.min(src.length - (s0 - start), bus.l.length - s0);
  for (let i = 0; i < n; i++) {
    const v = src[i + (s0 - start)]! * gain;
    bus.l[s0 + i]! += v * gl;
    bus.r[s0 + i]! += v * gr;
  }
}

/** one-pole low-pass in place */
export function lowpass(buf: Float32Array, cutoffHz: number | ((i: number) => number)): Float32Array {
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    const fc = typeof cutoffHz === "number" ? cutoffHz : cutoffHz(i);
    const a = 1 - Math.exp((-2 * Math.PI * Math.min(fc, SR * 0.45)) / SR);
    y += a * (buf[i]! - y);
    buf[i] = y;
  }
  return buf;
}

/** one-pole high-pass in place */
export function highpass(buf: Float32Array, cutoffHz: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * cutoffHz) / SR);
  let prevX = 0;
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i]!;
    y = a * (y + x - prevX);
    prevX = x;
    buf[i] = y;
  }
  return buf;
}

/** state-variable band-pass (Chamberlin) with optional swept centre frequency */
export function bandpass(buf: Float32Array, centre: number | ((i: number) => number), q = 1.2): Float32Array {
  let low = 0;
  let band = 0;
  const damp = 1 / q;
  for (let i = 0; i < buf.length; i++) {
    const fc = typeof centre === "number" ? centre : centre(i);
    const f = 2 * Math.sin((Math.PI * Math.min(fc, SR * 0.2)) / SR);
    const high = buf[i]! - low - damp * band;
    band += f * high;
    low += f * band;
    buf[i] = band;
  }
  return buf;
}

/** attack / exponential decay envelope multiplier at sample i */
export function adEnv(i: number, attack: number, decay: number): number {
  const t = i / SR;
  if (t < attack) return t / Math.max(1e-6, attack);
  return Math.exp(-(t - attack) / Math.max(1e-6, decay));
}

/** ADSR with gate length (seconds) */
export function adsr(i: number, a: number, d: number, s: number, r: number, gate: number): number {
  const t = i / SR;
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d);
  if (t < gate) return s;
  return s * Math.exp(-(t - gate) / Math.max(1e-6, r));
}

/* ------------------------------------------------------------------ instruments ----------------- */

export function kick(punch = 1): Float32Array {
  const n = Math.round(SR * 0.42);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 44 + 110 * Math.exp(-t / 0.035) * punch;
    ph += (2 * Math.PI * f) / SR;
    out[i] = Math.sin(ph) * Math.exp(-t / 0.22) + (i < 90 ? (1 - i / 90) * 0.35 : 0);
  }
  return out;
}

export function snare(rand: () => number, body = 190, decay = 0.16): Float32Array {
  const n = Math.round(SR * 0.3);
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = (rand() * 2 - 1) * Math.exp(-(i / SR) / decay);
  bandpass(noise, 3200, 0.8);
  for (let i = 0; i < n; i++)
    noise[i] = noise[i]! * 1.6 + Math.sin((2 * Math.PI * body * i) / SR) * Math.exp(-(i / SR) / 0.05) * 0.5;
  return noise;
}

export function clap(rand: () => number): Float32Array {
  const n = Math.round(SR * 0.26);
  const out = new Float32Array(n);
  const bursts = [0, 0.011, 0.023];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let env = 0;
    for (const b of bursts)
      if (t >= b) env = Math.max(env, Math.exp(-(t - b) / (b === 0.023 ? 0.09 : 0.008)));
    out[i] = (rand() * 2 - 1) * env;
  }
  return bandpass(out, 1500, 1.4);
}

export function hat(rand: () => number, open = false): Float32Array {
  const n = Math.round(SR * (open ? 0.22 : 0.06));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rand() * 2 - 1) * Math.exp(-(i / SR) / (open ? 0.08 : 0.016));
  return highpass(highpass(out, 7000), 7000);
}

export function shaker(rand: () => number): Float32Array {
  const n = Math.round(SR * 0.09);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rand() * 2 - 1) * adEnv(i, 0.012, 0.03);
  return bandpass(highpass(out, 4000), 6500, 0.7);
}

/** detuned-saw voice through an enveloped low-pass (bass, pads, leads) */
export function sawVoice(
  hz: number,
  seconds: number,
  opts: {
    voices?: number;
    detune?: number;
    cutoff?: number;
    cutoffEnv?: number;
    a?: number;
    d?: number;
    s?: number;
    r?: number;
    square?: boolean;
  } = {},
): Float32Array {
  const voices = opts.voices ?? 1;
  const detune = opts.detune ?? 0.006;
  const n = Math.round(SR * (seconds + (opts.r ?? 0.1) * 4));
  const out = new Float32Array(n);
  const phases = Array.from({ length: voices }, (_, v) => v / voices);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < voices; k++) {
      const f = hz * (1 + (k - (voices - 1) / 2) * detune);
      phases[k] = (phases[k]! + f / SR) % 1;
      v += opts.square ? (phases[k]! < 0.5 ? 1 : -1) : phases[k]! * 2 - 1;
    }
    out[i] = (v / voices) * adsr(i, opts.a ?? 0.005, opts.d ?? 0.2, opts.s ?? 0.6, opts.r ?? 0.1, seconds);
  }
  const base = opts.cutoff ?? 1800;
  const envAmt = opts.cutoffEnv ?? 0;
  return lowpass(out, envAmt ? (i) => base + envAmt * Math.exp(-(i / SR) / 0.12) : base);
}

/** Karplus-Strong plucked string */
export function pluck(hz: number, seconds: number, rand: () => number, brightness = 0.5): Float32Array {
  const n = Math.round(SR * seconds);
  const out = new Float32Array(n);
  const period = Math.max(2, Math.round(SR / hz));
  const ring = new Float32Array(period);
  for (let i = 0; i < period; i++) ring[i] = rand() * 2 - 1;
  lowpass(ring, 1500 + brightness * 6000);
  const damp = 0.996 - (1 - brightness) * 0.004;
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const next = (idx + 1) % period;
    const v = ring[idx]!;
    ring[idx] = damp * 0.5 * (v + ring[next]!);
    out[i] = v;
    idx = next;
  }
  return out;
}

/** electric-piano-ish tone: sine + soft 2nd/3rd harmonics with bell attack */
export function keys(hz: number, seconds: number, bright = 0.4): Float32Array {
  const n = Math.round(SR * (seconds + 0.6));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = adsr(i, 0.004, 0.6, 0.35, 0.35, seconds);
    const mod = Math.sin(2 * Math.PI * hz * 2 * t) * bright * 2.2 * Math.exp(-t / 0.25);
    out[i] = (Math.sin(2 * Math.PI * hz * t + mod) + 0.25 * Math.sin(2 * Math.PI * hz * 2 * t)) * env;
  }
  return out;
}

/** FM bell (shimmer, chimes) */
export function bell(hz: number, seconds: number): Float32Array {
  const n = Math.round(SR * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-t / (seconds * 0.35));
    out[i] =
      Math.sin(2 * Math.PI * hz * t + 1.8 * Math.exp(-t / 0.4) * Math.sin(2 * Math.PI * hz * 3.5 * t)) *
      env *
      Math.min(1, t / 0.002);
  }
  return out;
}

/** gentle soft clipper for the master */
export function softClip(bus: Stereo, drive = 1): void {
  for (const ch of [bus.l, bus.r])
    for (let i = 0; i < ch.length; i++) ch[i] = Math.tanh(ch[i]! * drive) / Math.tanh(drive);
}

export function peak(bus: Stereo): number {
  let p = 0;
  for (const ch of [bus.l, bus.r]) for (let i = 0; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i]!));
  return p;
}

/** 16-bit PCM WAV */
export function encodeWav(bus: Stereo): Buffer {
  const n = bus.l.length;
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, bus.l[i]!)) * 32767), i * 4);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, bus.r[i]!)) * 32767), i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Look-ahead peak limiter (sliding-window minimum of the required gain, averaged over the look-ahead for a
 * click-free attack, exponential release). Keeps the peak-to-loudness ratio low enough for −14 LUFS at −1.5 dBTP.
 */
export function limit(bus: Stereo, ceiling: number, lookaheadMs = 5, releaseMs = 90): void {
  const n = bus.l.length;
  const la = Math.max(1, Math.round((SR * lookaheadMs) / 1000));
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(Math.abs(bus.l[i]!), Math.abs(bus.r[i]!));
    req[i] = a > ceiling ? ceiling / a : 1;
  }
  // forward-looking window minimum (monotonic deque)
  const wmin = new Float32Array(n);
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const end = Math.min(n - 1, i + la);
    for (; j <= end; j++) {
      while (tail > head && req[dq[tail - 1]!]! >= req[j]!) tail--;
      dq[tail++] = j;
    }
    while (dq[head]! < i) head++;
    wmin[i] = req[dq[head]!]!;
  }
  // moving average over the look-ahead (attack ramp) then release smoothing
  const rel = 1 - Math.exp(-1 / ((SR * releaseMs) / 1000));
  let acc = 0;
  let g = 1;
  for (let i = 0; i < n; i++) {
    acc += wmin[i]!;
    if (i >= la) acc -= wmin[i - la]!;
    const avg = acc / Math.min(i + 1, la);
    g = Math.min(avg, g + (1 - g) * rel);
    bus.l[i] = bus.l[i]! * g;
    bus.r[i] = bus.r[i]! * g;
  }
}

export function rms(bus: Stereo): number {
  let s = 0;
  for (const ch of [bus.l, bus.r]) for (let i = 0; i < ch.length; i++) s += ch[i]! * ch[i]!;
  return Math.sqrt(s / (bus.l.length * 2));
}

/** RBJ biquad low-pass (Butterworth Q) in place — run twice for 24 dB/oct */
export function biquadLowpass(buf: Float32Array, fc: number, q = Math.SQRT1_2): Float32Array {
  const w0 = (2 * Math.PI * fc) / SR;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
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
