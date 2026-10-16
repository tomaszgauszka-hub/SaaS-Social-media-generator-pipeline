# 3D pipeline architecture

Blender and Unreal Engine 5 are **additional engines** that produce 3D clips for the existing reel generators.
They do not replace Creative Engine V2 (storyboard → Remotion → FFmpeg) or the sales reel factory; they feed them
clips through the existing asset system, queues, budget rules and approval workflow.

```
PRODUCT / OFFER
   │
CREATIVE DIRECTOR (packages/creative, no LLM)            ──▶ CreativeStoryboard + LocalePack per market
   │
STORYBOARD + ASSET REQUESTS  plan3dRequests()            ──▶ VisualBeat.asset3d / beat type → MaterialType3D → Recipe3D
   │
3D RENDER ROUTER  routeRender()                          ──▶ EXISTING_ASSET | PROGRAMMATIC_2D | BLENDER | UNREAL
   │                                                         | DEFER (station offline) | BLOCKED (policy)
   ├─ existing product media → 2D pipeline (no model is ever invented)
   ├─ BLENDER  tools/blender/scenes  (modelling · materials · animation · render)
   └─ UNREAL   tools/unreal          (import · environment · lighting · camera · Level Sequence · MRQ)
   │
RENDER WORKER  RenderWorker3D (job render3d.produce, queue render_3d)
   │  locks · free-memory check · timeout · cancel · telemetry · encode · clip QA · cleanup
ASSET LIBRARY + CACHE  Render3DAsset (Postgres) + Storage (local / S3 / R2) + Asset (VIDEO_CLIP mirror)
   │
apply3dClips()  ──▶ storyboard media swap (MediaRef.render3d), text slots untouched
   │
REMOTION / FFMPEG (packages/motion) ──▶ music + SFX, on-screen text, disclosure
   │
QA (technical · creative · factual · compliance · localization) + clip QA
   │
OWNER APPROVAL (panel /studio-3d, CreativeRender rows) ──▶ EXISTING PUBLISHING PIPELINE (unchanged, never automatic)
```

## Where the code lives

| Path                                                 | Role                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/render3d/src/contracts`                    | `Recipe3D` (closed sets + bounded numbers, no text / locale), `Asset3D` (library metadata, fidelity, licence), engine adapter contract |
| `packages/render3d/src/routing`                      | 3D render router + render time estimates (measured defaults, learned from telemetry)                                                   |
| `packages/render3d/src/cache/keys.ts`                | `visualKey` / `recipeHash` cache keys                                                                                                  |
| `packages/render3d/src/library`                      | `AssetLibrary3D` interface, file library, demo product + model file registration                                                       |
| `packages/render3d/src/engines/blender`              | Blender adapter (bpy module or `blender -b`)                                                                                           |
| `packages/render3d/src/engines/unreal`               | Unreal adapter (batch `UnrealEditor-Cmd`, Python remote execution)                                                                     |
| `packages/render3d/src/engines/{proc,encode,gpu}.ts` | shell-free process runner (process-tree kill), PNG → H.264 / VP9-alpha encoder, GPU probe                                              |
| `packages/render3d/src/qa/clip-qa.ts`                | technical QA of 3D clips                                                                                                               |
| `packages/render3d/src/worker`                       | render worker + resource sampling                                                                                                      |
| `packages/render3d/src/storyboard`                   | storyboard ⇄ clips, loopback media server for Remotion                                                                                 |
| `packages/render3d/src/mcp`                          | thin `render3d` MCP server (closed tool set)                                                                                           |
| `packages/pipeline/src/render3d-library.ts`          | Postgres library, render-station heartbeat                                                                                             |
| `packages/pipeline/src/steps/render3d.ts`            | `render3d.produce` job handler + outbox enqueue                                                                                        |
| `tools/blender/scenes`                               | parametric scene generators (Python, Blender 4.2 – 5.x)                                                                                |
| `tools/blender/studio`                               | the existing product studio (shared modules: framing, lighting, environments, import, compat)                                          |
| `tools/unreal`                                       | UE editor Python (scene build, Sequencer, Movie Render Queue, diagnostics)                                                             |
| `tools/mcp`                                          | Blender MCP launcher, headless add-on host, end-to-end MCP check                                                                       |
| `apps/web/src/app/(app)/studio-3d`                   | panel: generate, route preview, library, approval                                                                                      |

## Router: preference order

1. **Existing clip** — same `recipeHash` (exact), or same `visualKey` from another engine version (unless the
   owner rejected it).
2. **Re-render an existing model / scene** — a model in the library is always reused; nothing is rebuilt.
3. **Local 2D** — no 3D model of the product (the 2D pipeline animates the real product media), mode `2D_ONLY`,
   or the beat's predicted value is below `RENDER3D_MIN_VALUE`.
4. **Blender** with the existing model and a template.
5. **Blender** with a procedural model (repo demo products only — FICTIONAL_DEMO, DEMO_ONLY).
6. **Unreal Engine** for the cinematic templates (`UE_*`), when an Unreal station with a GPU is available. A plain
   turntable or hero never starts Unreal; without Unreal, `AUTO` maps a cinematic template to its Blender
   equivalent, a forced `UNREAL` waits (DEFER).
7. **External AI** is never chosen for product visuals (it would invent the product); it is listed as rejected.

Each decision carries reasons, rejected alternatives, the estimate (time, frames, local cost) and the cache keys.
Modes: `AUTO`, `BLENDER`, `UNREAL`, `2D_ONLY`, `EXISTING_ASSET`; `RENDER3D_SKIP_WHEN_OFFLINE` turns "station
offline" into 2D instead of waiting.

## Templates

Blender (`tools/blender/scenes`): `PRODUCT_HERO`, `TURNTABLE_360`, `MACRO_DETAIL` (focus part, rack focus, DOF),
`EXPLODED_VIEW`, `PRODUCT_ASSEMBLY`, `LIFESTYLE` (kitchen, bathroom, workshop, living room, desk, garage),
`TECHNICAL` (x-ray reveal of the mechanism, product actions), `BRAND_ENVIRONMENT` (brand colours, geometric
decor). Presets: 9 camera moves × 4 speeds, 7 lighting rigs, 7 backgrounds (incl. transparent with a shadow
catcher). Product actions: trigger press, chuck spin, LED on, clutch turn, gear shift, cap open, light on.

Unreal (`tools/unreal`): Luxury Product Studio, Automotive Cinematic, Modern Interior, Industrial Workshop,
Technology Showcase, Architectural Product Demo — set descriptions separate from the product, so any product swaps
in without rebuilding the set.

## Product fidelity (spec §13)

`Asset3D.fidelity`: `VERIFIED_MANUFACTURER` · `TECHNICAL_RECONSTRUCTION` · `APPROXIMATE_VISUALIZATION` ·
`FICTIONAL_DEMO`. Enforced in code, not by convention:

- a fictional demo model is always `isDemoOnly` and never product-verified; an approximate visualisation can never
  be marked verified (zod refinements);
- clips inherit their model's provenance (`inheritProvenance`); a demo clip turns the storyboard `demoOnly`, which
  the quality gates treat as never production-ready;
- exploded / assembly / technical templates need `structureVerified` (router → BLOCKED, Python validator → exit 3);
- technical clips are flagged `illustrative` in the storyboard media (`MediaRef.render3d.illustrative`) — a
  simulation, not a test result;
- model files register only with a commercial-use + adaptation licence (no NC / ND) and written evidence.

## Language independence

A recipe has no text, price, CTA, caption or locale field (the schema is `strict`). Cache keys are computed from
the recipe, the model identity and the scene scripts only — so a LocalePack change re-renders nothing in 3D, and
the same clip serves every market. Verified in Test D ([3D_PIPELINE_TEST_REPORT.md](3D_PIPELINE_TEST_REPORT.md)).

## Storyboard integration

- `MediaRef.render3d` (optional): asset id, material type, recipe hash, engine, fidelity, `illustrative`.
- `VisualBeat.asset3d` (optional): an explicit request (`materialType`, `focus`, `durationMs`).
- Defaults per beat type: hook/hero → `3D_PRODUCT_HERO`, macro / feature → `3D_MACRO` (focus = the beat's anchor
  mapped to a model part), spec → `3D_EXPLODED_VIEW` (turntable if the structure is not verified), in-use →
  `3D_LIFESTYLE`, process step → `3D_ASSEMBLY`, solution → `3D_TECHNICAL`, CTA → `3D_TURNTABLE`.
- Framing is text-aware: the clip leaves the beat's text boxes and panels clear (`framing.centerY` / `fill`).
- `apply3dClips` swaps the beat's primary media for the clip (full frame), keeps panels / lists / counters /
  badges, remaps callouts onto the clip's anchor of the same part (from the per-frame anchor tracks) and drops
  overlays drawn for the old media's geometry.
- Remotion loads clips from a loopback-only media server (whitelisted files, Range support).

## Security

- Engines run as plain processes (no shell), with a minimal environment (no API keys), under host-wide locks.
- Jobs and results are validated JSON: closed sets, bounded numbers, absolute paths inside the job directory; a
  result naming a file outside its output directory is rejected.
- No model-written code runs in production. MCP (interactive) is pinned, loopback-only and in safe mode.
- Nothing publishes automatically; demo clips are flagged `isMock` in the Asset table.
