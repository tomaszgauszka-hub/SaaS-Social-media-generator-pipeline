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
export * from "./ingest/index.ts";
export * from "./analysis/index.ts";
export * from "./director/index.ts";
export * from "./claims/index.ts";
export * from "./localize/index.ts";
export * from "./retrieval/index.ts";
export * from "./studio/index.ts";
export * from "./audio/index.ts";
export * from "./composer/index.ts";
export * from "./qa/index.ts";
export * from "./providers/google/index.ts";
export * from "./factory/index.ts";
