/**
 * Audio pipeline of the reel factory (local-first):
 *
 *   music    LocalMusicProvider (procedural composer: 8 genres × 8 moods, BPM-locked, energy automation,
 *            riser / drop / final_hit / stop) · CachedMusicProvider (music library, ±6 BPM) ·
 *            fitMusicToTimeline (any-length API music → bar-aligned, final-hit-aligned WAV of exact length)
 *   sfx      LocalSfxProvider (all SfxKinds synthesised) · CachedSfxProvider · ElevenLabsSfxProvider ·
 *            buildSfxCues (plan.sfx → timed files via the SFX chain)
 *   voice    PiperVoiceProvider · FliteVoiceProvider · ElevenLabsVoiceProvider · alignWords / estimateWords ·
 *            buildVoiceTrack (segments on the reel timeline → one WAV + words)
 *   captions buildCaptionTrack (phrases, timing, style, box)
 */
export * from "./analysis.ts";
export * from "./pcm.ts";
export * from "./captions.ts";
export * from "./music/arrange.ts";
export * from "./music/fit.ts";
export * from "./music/library.ts";
export * from "./music/local.ts";
export {
  renderArrangement,
  renderMusic,
  energyCutoff,
  energyLevelDb,
  LOCAL_MUSIC_VERSION,
  MUSIC_CEILING_DB,
  type RenderedMusic,
} from "./music/render.ts";
export { GENRE_STYLES, MOOD_HARMONY, type GenreStyle, type MoodHarmony, type Chord } from "./music/styles.ts";
export * from "./sfx/cues.ts";
export * from "./sfx/providers.ts";
export {
  renderSfx as renderSfxSound,
  sfxLengthMs,
  SFX_LENGTH_MS,
  SFX_PEAK_DB,
  LOCAL_SFX_VERSION,
  type SfxSound,
} from "./sfx/synth.ts";
export * from "./voice/align.ts";
export * from "./voice/elevenlabs.ts";
export * from "./voice/flite.ts";
export * from "./voice/piper.ts";
export * from "./voice/process.ts";
export * from "./voice/text.ts";
export * from "./voice/track.ts";
