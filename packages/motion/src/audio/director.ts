import type { RenderPlan } from "@cre/creative";
import { renderMusic } from "./music.ts";
import { renderSfx } from "./sfx.ts";
import {
  SR,
  biquadLowpass,
  dbGain,
  encodeWav,
  limit,
  panGains,
  peak,
  prng,
  rms,
  softClip,
  stereo,
  type Stereo,
} from "./synth.ts";

/**
 * AudioDirector (spec §36): music bed + synchronised sound design from the storyboard's AudioPlan.
 * Voice-over stays off until the master is approved (no TTS spend on drafts). Output is a raw mix; loudness
 * normalisation (−14 LUFS, true peak −1.5 dBTP) is done by FFmpeg in finish.ts.
 */
export interface AudioMix {
  wav: Buffer;
  samples: number;
  peak: number;
  sfxCount: number;
}

function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mixAudio(plan: RenderPlan): AudioMix {
  const samples = Math.round((plan.durationInFrames / plan.format.fps) * SR);
  const seed = seedOf(plan.storyboardHash || plan.storyboardId);
  const bus: Stereo = stereo(samples);
  const rand = prng(seed ^ 0x9e3779b9);

  // music: normalised bed at the plan's relative level, 0.6 s fade-in feel via the first downbeat, fade-out
  const music = renderMusic(plan.audio.music.mood, plan.audio.music.bpm, samples, seed);
  const mp = Math.max(1e-6, peak(music));
  const mg = (0.5 / mp) * dbGain(plan.audio.music.gainDb + 9);
  const fadeOut = Math.round(SR * 0.8);
  for (let i = 0; i < samples; i++) {
    const g = mg * (i > samples - fadeOut ? (samples - i) / fadeOut : 1) * Math.min(1, i / (SR * 0.02));
    bus.l[i] = music.l[i]! * g;
    bus.r[i] = music.r[i]! * g;
  }

  // sound design at the director's cue points
  for (const cue of plan.audio.sfx) {
    const v = renderSfx(cue.kind, rand);
    const start = Math.round(((cue.atMs - v.leadMs) / 1000) * SR);
    const g = dbGain(cue.gainDb + 8);
    const n = v.samples.length;
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      if (idx < 0 || idx >= samples) continue;
      const [gl, gr] = panGains(v.pan[0] + (v.pan[1] - v.pan[0]) * (i / n));
      const s = v.samples[i]! * g;
      bus.l[idx]! += s * gl;
      bus.r[idx]! += s * gr;
    }
  }

  // master: level to −18 dBFS RMS, then limit peaks to −8 dBFS so the loudness target is reachable without
  // pumping (sample peak-to-RMS ≈ 9 dB: noisy transients overshoot ~2 dB between samples); FFmpeg two-pass loudnorm
  // then lands on −14 LUFS in linear mode
  // 24 dB/oct roll-off above 15 kHz: synthetic noise up to Nyquist only adds inter-sample peaks
  for (const ch of [bus.l, bus.r]) biquadLowpass(biquadLowpass(ch, 15_000), 15_000);
  const r = Math.max(1e-6, rms(bus));
  const lvl = dbGain(-18) / r;
  for (const ch of [bus.l, bus.r]) for (let i = 0; i < ch.length; i++) ch[i] = ch[i]! * lvl;
  limit(bus, dbGain(-8));
  softClip(bus, 1.05);
  const p = peak(bus);
  return { wav: encodeWav(bus), samples, peak: p, sfxCount: plan.audio.sfx.length };
}
