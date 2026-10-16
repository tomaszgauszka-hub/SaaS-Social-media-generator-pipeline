/*
 * Runtime bridge from the web app to the 3D backend.
 *
 * JavaScript on purpose, so the web app's TypeScript program does not follow these imports: the package entry
 * points also reach packages/render3d/src/engines/proc.ts and packages/reel/src/studio/run.ts, which do not
 * type-check under Next.js' global typing (`ProcessEnv.NODE_ENV` is required there). Types come from
 * ./render3d-runtime.d.ts.
 *
 * Bundling: "@cre/render3d" resolves to ./render3d-server-entry.js (next.config.ts), and the two @cre/pipeline
 * modules are imported directly rather than through the pipeline barrel (which loads every step handler, BullMQ and
 * the reel factory). The code that runs is the packages' own: nothing is re-implemented here.
 */
export {
  canonical,
  costAssumptionsFromEnv,
  DEMO_PRODUCTS,
  estimateRender,
  localRenderCost,
  registerDemoProduct,
  routeRender,
  sha256,
  visualKey,
} from "@cre/render3d";
export {
  onlineRenderStations,
  PrismaAssetLibrary3D,
} from "../../../../packages/pipeline/src/render3d-library.ts";
export { enqueueRender3d } from "../../../../packages/pipeline/src/steps/render3d.ts";
