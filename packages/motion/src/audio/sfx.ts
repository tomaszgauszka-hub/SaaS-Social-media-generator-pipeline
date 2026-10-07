import type { SfxKind } from "@cre/creative";
import { SR, bandpass, bell, highpass, kick, lowpass, midiHz } from "./synth.ts";

/** Synthesised sound effects for transitions and overlay events (whoosh, tick, pop, impact, riser …). */
export interface SfxVoice {
  samples: Float32Array;
  /** pan at the start / end of the sound (sweeps) */
  pan: [number, number];
  /** offset so the sound's peak lands on the cue (e.g. a whoosh peaks on the cut) */
  leadMs: number;
}

function noise(n: number, rand: () => number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rand() * 2 - 1;
  return out;
}

export function renderSfx(kind: SfxKind, rand: () => number): SfxVoice {
  switch (kind) {
    case "whoosh": {
      const n = Math.round(SR * 0.5);
      const out = bandpass(noise(n, rand), (i) => 350 + 3600 * Math.sin((Math.PI * i) / n) ** 2, 0.9);
      for (let i = 0; i < n; i++) out[i] = out[i]! * Math.sin((Math.PI * i) / n) ** 1.6 * 2.2;
      return { samples: out, pan: [-0.6, 0.6], leadMs: 0 };
    }
    case "swipe": {
      const n = Math.round(SR * 0.26);
      const out = bandpass(noise(n, rand), (i) => 1500 + 4500 * (i / n), 1.1);
      for (let i = 0; i < n; i++) out[i] = out[i]! * Math.sin((Math.PI * i) / n) ** 1.2 * 1.8;
      return { samples: out, pan: [0.4, -0.4], leadMs: 0 };
    }
    case "tick": {
      const n = Math.round(SR * 0.04);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++)
        out[i] =
          Math.sin((2 * Math.PI * 3100 * i) / SR) * Math.exp(-i / (SR * 0.006)) +
          (rand() * 2 - 1) * Math.exp(-i / (SR * 0.0015)) * 0.4;
      return { samples: out, pan: [0.15, 0.15], leadMs: 0 };
    }
    case "click": {
      const n = Math.round(SR * 0.025);
      const out = highpass(noise(n, rand), 3000);
      for (let i = 0; i < n; i++)
        out[i] =
          out[i]! * Math.exp(-i / (SR * 0.002)) +
          Math.sin((2 * Math.PI * 1800 * i) / SR) * Math.exp(-i / (SR * 0.004)) * 0.5;
      return { samples: out, pan: [0, 0], leadMs: 0 };
    }
    case "pop": {
      const n = Math.round(SR * 0.14);
      const out = new Float32Array(n);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        ph += (2 * Math.PI * (260 + 640 * Math.exp(-t / 0.025))) / SR;
        out[i] = Math.sin(ph) * Math.exp(-t / 0.045) * Math.min(1, i / 40);
      }
      return { samples: out, pan: [0, 0], leadMs: 0 };
    }
    case "impact": {
      const k = kick(1.6);
      const n = Math.round(SR * 0.9);
      const out = new Float32Array(n);
      const crash = lowpass(noise(n, rand), 2600);
      for (let i = 0; i < n; i++)
        out[i] =
          (k[i] ?? 0) * 1.1 +
          crash[i]! * Math.exp(-i / (SR * 0.22)) * 0.9 +
          Math.sin((2 * Math.PI * 42 * i) / SR) * Math.exp(-i / (SR * 0.4)) * 0.5;
      return { samples: out, pan: [0, 0], leadMs: 0 };
    }
    case "riser": {
      const n = Math.round(SR * 1.05);
      const nz = bandpass(noise(n, rand), (i) => 400 + 5600 * (i / n) ** 2, 1.4);
      const out = new Float32Array(n);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        ph += (2 * Math.PI * (180 + 700 * t * t)) / SR;
        out[i] = (nz[i]! * 1.4 + (((ph / (2 * Math.PI)) % 1) - 0.5) * 0.25) * t ** 2.2;
      }
      return { samples: out, pan: [-0.3, 0.3], leadMs: 0 };
    }
    case "shimmer": {
      const n = Math.round(SR * 0.9);
      const out = new Float32Array(n);
      [88, 95, 100].forEach((m, k) => {
        const b = bell(midiHz(m), 0.8);
        const off = Math.round(SR * 0.06 * k);
        for (let i = 0; i < b.length && i + off < n; i++) out[i + off] = out[i + off]! + b[i]! * 0.35;
      });
      return { samples: out, pan: [-0.5, 0.5], leadMs: 0 };
    }
  }
}
