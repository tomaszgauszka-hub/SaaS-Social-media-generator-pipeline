/**
 * @cre/reel — the sales reel factory.
 *
 *   PRODUCT → ProductProfile → AssetRetriever → ReelDirector → ReelPlan → Blender studio / existing assets
 *   → music · voice · SFX · captions → ReelComposer (FFmpeg) → QA (+ deterministic retry) → manifest
 *   → localized variants reusing the master video.
 *
 * A model decides WHAT (small validated JSON); code decides HOW (keyframes, FFmpeg arguments, provider calls).
 */
export * from "./contracts/index.ts";
export * from "./capabilities/index.ts";
export * from "./cost/index.ts";
export * from "./util/index.ts";
