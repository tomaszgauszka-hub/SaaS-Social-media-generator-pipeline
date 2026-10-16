import path from "node:path";
import { FatalError } from "@cre/shared";
import type { Asset3D, Fidelity } from "../contracts/asset.ts";
import type { ProductAction } from "../contracts/recipe.ts";
import type { AssetLibrary3D } from "./library.ts";

/*
 * Product model registration. A product enters the 3D library once, with its provenance:
 *   - procedural demo models (FICTIONAL_DEMO, DEMO_ONLY) built from the demo product data already in the repo;
 *   - model files (catalog / manufacturer / commissioned), with licence + evidence and a fidelity level.
 * Registration is idempotent: the same source registers the same asset (no duplicate models).
 */

export interface ProceduralProduct {
  generator: string;
  version: number;
  productId: string;
  category: string;
  description: string;
  /** nominal real dimensions of the demo model (m: x, y, z) */
  dimensionsM: [number, number, number];
  parts: { name: string; role: string; internal?: boolean }[];
  actions: ProductAction[];
  params?: Record<string, number | string | boolean>;
  /** demo product data this model follows */
  basedOn: string;
}

/** The repo's DEMO_ONLY benchmark products (packages/creative/src/benchmark/briefs.ts) as procedural 3D models. */
export const DEMO_PRODUCTS: Record<string, ProceduralProduct> = {
  "demo-drill-20v": {
    generator: "drill_driver_20v",
    version: 1,
    productId: "bench-tools-drill",
    category: "tools",
    description:
      "20V Cordless Drill/Driver Kit (demo): 13 mm keyless chuck, 2-speed gearbox, 21 + drill clutch settings, LED work light, slide-on 20 V battery",
    dimensionsM: [0.2685, 0.0809, 0.241],
    parts: [
      { name: "housing", role: "body" },
      { name: "battery", role: "accessory" },
      { name: "charge_gauge", role: "detail" },
      { name: "clutch", role: "control" },
      { name: "chuck", role: "detail" },
      { name: "bit", role: "accessory" },
      { name: "trigger", role: "control" },
      { name: "direction_switch", role: "control" },
      { name: "gear_selector", role: "control" },
      { name: "led", role: "detail" },
      { name: "motor", role: "internal", internal: true },
      { name: "gearbox", role: "internal", internal: true },
    ],
    actions: ["TRIGGER_PRESS", "CHUCK_SPIN", "LED_ON", "CLUTCH_TURN", "GEAR_SHIFT"],
    basedOn: "packages/creative/src/benchmark/briefs.ts BENCH_TOOLS (bench-tools-drill)",
  },
  "demo-sunscreen-tube": {
    generator: "cosmetic_tube",
    version: 1,
    productId: "bench-beauty-sunscreen",
    category: "beauty",
    description: "Mineral Sun Fluid SPF 50, 50 ml squeeze tube with flip-top cap (demo)",
    dimensionsM: [0.0545, 0.0418, 0.145],
    parts: [
      { name: "body", role: "body" },
      { name: "crimp", role: "detail" },
      { name: "cap", role: "accessory" },
      { name: "cap_lid", role: "control" },
    ],
    actions: ["CAP_OPEN"],
    basedOn: "packages/creative/src/benchmark/briefs.ts BENCH_BEAUTY (bench-beauty-sunscreen)",
  },
};

export async function registerDemoProduct(
  library: AssetLibrary3D,
  assetId: keyof typeof DEMO_PRODUCTS,
): Promise<Asset3D> {
  const d = DEMO_PRODUCTS[assetId];
  if (!d) throw new FatalError(`unknown demo product ${assetId}`);
  const existing = await library.get(assetId);
  if (existing && existing.generator?.version === d.version) return existing;
  return library.put({
    assetId,
    assetType: "PRODUCT_MODEL",
    productId: d.productId,
    category: d.category,
    source: `procedural:${d.generator}@${d.version}`,
    license: "own procedural model (repository code)",
    licenseEvidence: `tools/blender/scenes/products.py ${d.generator} v${d.version}; follows ${d.basedOn}`,
    isSynthetic: true,
    isDemoOnly: true,
    isProductVerified: false,
    fidelity: "FICTIONAL_DEMO",
    structureVerified: true,
    engine: "blender",
    generator: { name: d.generator, version: d.version, params: d.params ?? {} },
    version: existing ? existing.version + 1 : 1,
    createdAt: new Date().toISOString(),
    parts: d.parts.map((p) => ({
      name: p.name,
      role: p.role,
      verified: true,
      internal: p.internal ?? false,
    })),
    actions: d.actions,
    dimensionsM: d.dimensionsM,
  });
}

export interface ModelFileRegistration {
  assetId: string;
  file: string;
  productId: string;
  brandId?: string | null;
  category: string;
  source: string;
  license: string;
  licenseEvidence: string;
  fidelity: Exclude<Fidelity, "FICTIONAL_DEMO">;
  /** the owner confirmed the model shows the real product (verified / reconstructed models only) */
  productVerified?: boolean;
  /** named, real parts (manufacturer CAD); otherwise structural templates are refused */
  structureVerified?: boolean;
  dimensionsM?: [number, number, number] | null;
  actions?: ProductAction[];
}

/** licences that allow commercial use AND adaptation (a render is an adaptation): no NC, no ND */
const COMMERCIAL_OK =
  /^(CC0( 1\.0)?|CC BY( [0-9.]+)?|CC-BY(-[0-9.]+)?|MIT|owned|own|commissioned|manufacturer(:.+)?|licensed:.+)$/i;
const RESTRICTED = /\b(NC|ND|non-?commercial|no-?deriv)/i;

/** Register a model file (stored in the library's Storage). Refuses files without a commercial-use licence. */
export async function registerModelFile(library: AssetLibrary3D, r: ModelFileRegistration): Promise<Asset3D> {
  if (!COMMERCIAL_OK.test(r.license.trim()) || RESTRICTED.test(r.license))
    throw new FatalError(
      `licence "${r.license}" is not cleared for commercial use — register CC0 / CC BY / owned / manufacturer / licensed:<contract> models only`,
    );
  if (!r.licenseEvidence.trim()) throw new FatalError("licence evidence is required");
  const ext = path.extname(r.file).slice(1).toLowerCase();
  if (!["glb", "gltf", "obj", "fbx", "blend"].includes(ext))
    throw new FatalError(`unsupported model format .${ext}`);
  const existing = await library.get(r.assetId);
  const asset = await library.put(
    {
      assetId: r.assetId,
      assetType: "PRODUCT_MODEL",
      productId: r.productId,
      brandId: r.brandId ?? null,
      category: r.category,
      source: r.source,
      license: r.license,
      licenseEvidence: r.licenseEvidence,
      isSynthetic: false,
      isDemoOnly: false,
      isProductVerified: Boolean(r.productVerified) && r.fidelity !== "APPROXIMATE_VISUALIZATION",
      fidelity: r.fidelity,
      structureVerified: Boolean(r.structureVerified),
      engine: "none",
      version: existing ? existing.version : 1,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      actions: r.actions ?? [],
      dimensionsM: r.dimensionsM ?? null,
    },
    [{ role: "source_model", localPath: r.file }],
  );
  // a changed file is a new model version (its renders get new cache keys); an identical one is a no-op
  const before = existing?.outputFiles.find((f) => f.role === "source_model")?.sha256;
  const after = asset.outputFiles.find((f) => f.role === "source_model")?.sha256;
  if (existing && before && after && before !== after)
    return library.put({ ...asset, version: existing.version + 1 });
  return asset;
}
