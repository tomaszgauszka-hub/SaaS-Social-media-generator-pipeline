/**
 * Blender product studio bridge: ReelPlan → StudioJob → Blender (tools/blender/studio) → shot clips.
 *
 *   produceShotClips(plan, product, profile, ctx)   everything below, with per-shot render + clip caches
 *   buildStudioJob / runStudio                      the JSON contract and the no-shell Blender run
 *   encodeShotClip / buildShotClipArgs              FFmpeg moves (plate / relight / sequence) + product track
 */
export * from "./moves.ts";
export * from "./job.ts";
export * from "./cache.ts";
export * from "./run.ts";
export * from "./encode.ts";
export * from "./produce.ts";
