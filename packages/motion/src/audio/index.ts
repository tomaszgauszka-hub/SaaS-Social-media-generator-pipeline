/**
 * Public surface of the deterministic synth (oscillators, envelopes, filters, effects, instruments, WAV) for
 * other packages that compose their own audio — e.g. the reel factory's local music / SFX providers. The
 * AudioDirector of the creative engine (director.ts, music.ts, sfx.ts) stays internal.
 */
export * from "./synth.ts";
export * from "./dsp.ts";
export * from "./instruments.ts";
