# 3D asset library

Persistent library of product models, props, scenes, PBR materials, HDRIs, light rigs, animations, camera moves,
rendered clips, alpha stills and render presets (`AssetType3D`). Binaries live in the app's **Storage provider**
(local disk, S3 or R2 — `STORAGE_DRIVER`); PostgreSQL keeps only metadata (`Render3DAsset`, additive migration
`20261016125322_render3d_library`). Rendered clips are also mirrored into the existing `Asset` table
(`VIDEO_CLIP`, origin `RENDERED`, idempotency key `render3d:<assetId>`), so dashboards, the asset proxy and
cleanup see them like any other asset.

## Metadata (`packages/render3d/src/contracts/asset.ts`)

| Spec field                                        | `Asset3D`                                                                                                                                            | Notes                                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| asset_id                                          | `assetId`                                                                                                                                            | SafeId (no path characters)                                                                                                       |
| asset_type                                        | `assetType`                                                                                                                                          | PRODUCT_MODEL … RENDER_PRESET                                                                                                     |
| product_id / brand_id                             | `productId` / `brandId`                                                                                                                              |                                                                                                                                   |
| category                                          | `category`                                                                                                                                           |                                                                                                                                   |
| source                                            | `source`                                                                                                                                             | `procedural:<generator>@<v>`, `abo:<item>`, `manufacturer:<ref>`, `render:<recipeHash>`                                           |
| license / license_evidence                        | `license` / `licenseEvidence`                                                                                                                        | evidence is required (URL, file or statement)                                                                                     |
| is_synthetic / is_demo_only / is_product_verified | `isSynthetic` / `isDemoOnly` / `isProductVerified`                                                                                                   | + `fidelity`, `structureVerified`                                                                                                 |
| engine                                            | `engine`, `engineVersion`                                                                                                                            | blender · unreal · none                                                                                                           |
| source_file                                       | `sourceFile` + `outputFiles[role=source_model]`                                                                                                      |                                                                                                                                   |
| version                                           | `version`                                                                                                                                            | a changed model file → new version → new cache keys                                                                               |
| geometry_hash / material_hash                     | `geometryHash` / `materialHash`                                                                                                                      | computed by Blender from the evaluated mesh / node graphs                                                                         |
| scene_hash / render_settings_hash                 | `sceneHash` / `renderSettingsHash`                                                                                                                   | render settings hash = engine identity (engine, version, device)                                                                  |
| output_files                                      | `outputFiles[]`                                                                                                                                      | `{role, key, sizeBytes, sha256, contentType}` — video, thumbnail, metadata, alpha_video, control_sheet, blend, glb, fbx, ue_level |
| duration / resolution / fps                       | `durationMs` / `resolution` / `fps`                                                                                                                  |                                                                                                                                   |
| render_time_ms / render_cost_estimate             | `renderTimeMs` / `renderCostEstimateUsd`                                                                                                             | local cost model (energy + amortisation)                                                                                          |
| created_at                                        | `createdAt`                                                                                                                                          |                                                                                                                                   |
| —                                                 | `recipeHash`, `visualKey`, `materialType`, `template`, `quality`, `parentAssetIds`, `parts`, `actions`, `dimensionsM`, `telemetry`, `qa`, `approval` |                                                                                                                                   |

Every record is validated by the zod contract on read; a row that does not validate is ignored, never trusted.

## Cache keys (`packages/render3d/src/cache/keys.ts`)

```
visualKey  = sha256(recipe fields that change pixels + product identity + scene-script hash)
recipeHash = sha256(visualKey + engine identity "engine|version|device")
```

- product identity: asset id, version, source, the model file's sha256 or the generator + params — never names;
- the scene-script hash covers every non-test module of `tools/blender/scenes` and `tools/blender/studio`, so
  editing a template invalidates exactly what it rendered;
- the engine mode (`AUTO` …) and the `metadata` output are not part of the picture and are left out;
- no text, locale or price exists in a recipe → language changes never re-render 3D.

Lookups: `findByRecipeHash` (exact) and `findByVisualKey` (same picture from another engine version — reused by
default, `reuseAcrossEngineVersions`). Rejected clips are never reused.

## Deduplication

Before a file is stored its sha256 is looked up in every record's `outputFiles`; an identical file is referenced,
not copied (`storeFiles`). Product models are registered idempotently: the same file → same record; a changed file
→ `version + 1`.

## Registering models

```ts
import { registerDemoProduct, registerModelFile } from "@cre/render3d";
await registerDemoProduct(library, "demo-drill-20v"); // procedural, FICTIONAL_DEMO, DEMO_ONLY
await registerModelFile(library, {
  assetId: "abo-b075x2fzsm",
  file: ".data/products/abo/B075X2FZSM/model.glb",
  productId: "B075X2FZSM",
  category: "lamp",
  source: "abo:B075X2FZSM",
  license: "CC BY 4.0",
  licenseEvidence: "https://amazon-berkeley-objects.s3.amazonaws.com/index.html",
  fidelity: "TECHNICAL_RECONSTRUCTION",
  dimensionsM: [0.3632, 0.3632, 0.5512],
});
```

`registerModelFile` refuses licences without commercial use **and** adaptation rights (`CC BY-NC`, `CC BY-ND`,
"non-commercial", "no derivatives"); accepted: CC0, CC BY, MIT, own / commissioned / manufacturer,
`licensed:<contract>`. `isProductVerified` needs a verified or reconstructed model and the owner's confirmation;
`structureVerified` (exploded / assembly / technical) only for models with real named parts (manufacturer CAD).

## Approval

Every clip starts `PENDING`. Approve / reject in the panel (`/studio-3d`), recorded with the user's email and
time. Production renders of a recipe require an **approved preview** of the same recipe
(`RENDER3D_REQUIRE_APPROVED_PREVIEW`, default on). There is no approval tool in MCP.
