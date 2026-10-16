/*
 * Types of ./render3d-runtime.js (see there for why the bridge exists). Everything that has a type-checkable source
 * module is re-exported from it, so these are the packages' real signatures; only the three @cre/pipeline symbols
 * are declared by hand (their module imports the @cre/render3d entry point) — keep them in sync with
 * packages/pipeline/src/render3d-library.ts and packages/pipeline/src/steps/render3d.ts.
 */
import type { DbClient, PrismaClient, RenderStation } from "@cre/db";
import type { StorageProvider } from "@cre/providers";
import type { ApprovalStatus, Asset3D, Asset3DInput, OutputRole } from "@cre/render3d/contracts";
import type {
  AssetLibrary3D,
  LibraryFile,
  LibraryFilter,
} from "../../../../packages/render3d/src/library/library.ts";
import type { TimingSample } from "../../../../packages/render3d/src/routing/estimate.ts";

export { canonical, sha256, visualKey } from "../../../../packages/render3d/src/cache/keys.ts";
export { costAssumptionsFromEnv, localRenderCost } from "../../../../packages/render3d/src/cost/local.ts";
export { estimateRender, type TimingSample } from "../../../../packages/render3d/src/routing/estimate.ts";
export {
  routeRender,
  type LibraryLookup,
  type RouteDecision,
} from "../../../../packages/render3d/src/routing/router.ts";
export { DEMO_PRODUCTS, registerDemoProduct } from "../../../../packages/render3d/src/library/products.ts";
export type { AssetLibrary3D } from "../../../../packages/render3d/src/library/library.ts";

/** packages/pipeline/src/render3d-library.ts — PostgreSQL metadata + Storage files (not workspace-filtered). */
export declare class PrismaAssetLibrary3D implements AssetLibrary3D {
  constructor(prisma: PrismaClient, storage: StorageProvider, workspaceId: string | null);
  get(assetId: string): Promise<Asset3D | null>;
  list(filter?: LibraryFilter): Promise<Asset3D[]>;
  findByRecipeHash(hash: string): Promise<Asset3D | null>;
  findByVisualKey(key: string): Promise<Asset3D | null>;
  findProductModel(productId: string): Promise<Asset3D | null>;
  put(asset: Asset3DInput, files?: readonly LibraryFile[]): Promise<Asset3D>;
  setApproval(assetId: string, status: ApprovalStatus, by: string, note?: string): Promise<Asset3D>;
  localPath(asset: Asset3D, role: OutputRole): Promise<string | null>;
  timingHistory(): Promise<TimingSample[]>;
}

/** packages/pipeline/src/render3d-library.ts — stations seen in the last `maxAgeMs` (default 2 min). */
export declare function onlineRenderStations(
  prisma: PrismaClient,
  maxAgeMs?: number,
  now?: Date,
): Promise<RenderStation[]>;

/** packages/pipeline/src/steps/render3d.ts — Render3DProducePayload & { workspaceId }. */
export interface EnqueueRender3dInput {
  jobId: string;
  recipe: unknown;
  valueScore?: number;
  brandId?: string | null;
  /** one of DEMO_PRODUCTS' keys: registered by the worker before rendering */
  demoProduct?: string;
  workspaceId?: string | null;
}

/** packages/pipeline/src/steps/render3d.ts — transactional outbox, idempotent per jobId. */
export declare function enqueueRender3d(
  db: DbClient,
  input: EnqueueRender3dInput,
): Promise<{ id: string; created: boolean }>;
