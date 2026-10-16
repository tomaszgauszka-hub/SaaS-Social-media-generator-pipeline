/*
 * Slim server entry of @cre/render3d for the web bundle: next.config.ts aliases the package's root import to this
 * file (Turbopack only; TypeScript never sees it). It re-exports the package's pure modules — contracts, cache keys,
 * local cost, estimates, router, library helpers and demo product registration — and leaves out the engine
 * adapters, encoder, worker and setup: setup.ts pulls in the whole reel factory (@cre/reel → @cre/creative/node.ts
 * with dynamic @fontsource CSS lookups) that Turbopack cannot bundle, and the web app never renders or probes
 * engines itself.
 */
export * from "../../../../packages/render3d/src/contracts/index.ts";
export * from "../../../../packages/render3d/src/cache/keys.ts";
export * from "../../../../packages/render3d/src/cost/local.ts";
export * from "../../../../packages/render3d/src/routing/estimate.ts";
export * from "../../../../packages/render3d/src/routing/router.ts";
export * from "../../../../packages/render3d/src/library/library.ts";
export * from "../../../../packages/render3d/src/library/products.ts";

/** Engines and the render worker run on the render station (apps/worker), never inside the web app. */
export function createRender3D() {
  throw new Error("createRender3D is not available in the web app — 3D renders run on the render station");
}
