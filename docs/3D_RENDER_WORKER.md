# 3D render worker

Blender and Unreal run on a **local machine or a dedicated render station** — never in Vercel / serverless
functions. The station runs the normal worker (`pnpm worker`, or `WORKER_QUEUES=render_3d pnpm worker` for a
station that only renders 3D). Jobs run without any conversation with Claude: saved recipes → scripts.

## Job

`render3d.produce` on queue `render_3d` (timeout 4 h, 3 attempts) through the transactional outbox:

```ts
import { enqueueRender3d } from "@cre/pipeline";
await enqueueRender3d(prisma, {
  jobId: "hero-drill-001", // idempotency: the same id is enqueued once
  recipe: { template: "PRODUCT_HERO", productAssetId: "demo-drill-20v", durationSec: 4 },
  demoProduct: "demo-drill-20v", // optional: register a repo demo product first
  workspaceId,
});
```

The panel (`/studio-3d`) enqueues the same job. The handler returns `{engine, reasons, assetId, reused, qaPassed,
qaScore, costUsd, renderMs}`.

## What one run does (`RenderWorker3D.run`)

1. **Route** (library hit → done, no render; 2D → the caller uses the 2D pipeline; BLOCKED → fatal).
2. **Preview gate**: a production recipe needs an owner-approved preview of the same recipe.
3. **Resource reservation**: free memory vs the estimate (else `DeferredError`, retried in 2 min), then the
   host-wide `render-heavy` semaphore (`RENDER3D_MAX_CONCURRENT`, shared by Blender and Unreal) and the engine's own
   slot (`blender` — the same lock and `BLENDER_MAX_CONCURRENT` the reel studio uses — or `unreal`, 1).
4. **Render** with a timeout (4 × estimate, ≥ 10 min, ≤ the job timeout), abort signal (kills the whole process
   tree), progress lines and resource sampling (peak RAM and CPU of the process tree via /proc; VRAM and GPU load
   via nvidia-smi).
5. **Encode** PNG → H.264 (preview: 15 fps rendered, motion-compensated interpolation to the clip fps; production:
   every frame), optional VP9 with alpha, thumbnail (frame with the largest product), control sheet.
6. **Clip QA** (resolution, fps, duration, completeness, black frames, missing textures, product in frame / size,
   exposure, flicker, alpha border, proportions vs real dimensions). Technical only — owner approval stays.
7. **Store** files in Storage + metadata in the library (`PENDING` approval) + telemetry + local cost.
8. **Cleanup**: the scratch directory is deleted on success and on failure.

## Failure handling

| Situation                                           | Error                                                    | Runner behaviour                                                                    |
| --------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Station off / engine not installed / editor closed  | `DeferredError` (router DEFER, `EngineUnavailableError`) | job parked `RETRYING`, `runAt` +10 min, **attempt given back** — safe and resumable |
| Not enough free memory                              | `DeferredError` (2 min)                                  | same                                                                                |
| Timeout, crash, GPU out of memory, killed           | `RetryableError`                                         | exponential backoff, then dead letter                                               |
| Invalid recipe / job, invalid engine result, policy | `FatalError`                                             | failed, not retried                                                                 |
| Worker shutdown                                     | abort signal                                             | process tree killed, attempt given back                                             |

`RENDER3D_SKIP_WHEN_OFFLINE=1` routes to 2D instead of deferring.

## Render-station heartbeat

Every worker serving `render_3d` writes `RenderStation` (hostname, last seen, Blender / Unreal capabilities, GPU,
active jobs) every 30 s and around each job. A station not seen for 2 min is offline: the panel shows it and the
router treats it as offline.

## Configuration (.env)

| Variable                                                                                                                                                                  | Default                              |                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `BLENDER_PYTHON` / `BLENDER_BIN`                                                                                                                                          | `.tools/blender-venv/bin/python` / – | bpy module or a Blender executable (e.g. `C:\Program Files\Blender Foundation\Blender 4.3\blender.exe`) |
| `RENDER3D_DEVICE`                                                                                                                                                         | `AUTO`                               | `GPU` uses the best Cycles backend (OptiX, CUDA, HIP, Metal, oneAPI), CPU fallback                      |
| `RENDER3D_MAX_CONCURRENT`                                                                                                                                                 | 1                                    | heavy renders at once (Blender + Unreal together)                                                       |
| `BLENDER_MAX_CONCURRENT`, `BLENDER_THREADS`                                                                                                                               | 1, 0                                 | shared with the reel studio                                                                             |
| `RENDER3D_SKIP_WHEN_OFFLINE`                                                                                                                                              | false                                |                                                                                                         |
| `RENDER3D_MIN_VALUE`                                                                                                                                                      | 0                                    | predicted value below which 3D is not used                                                              |
| `RENDER3D_REQUIRE_APPROVED_PREVIEW`                                                                                                                                       | true                                 |                                                                                                         |
| `RENDER3D_DATA_DIR`                                                                                                                                                       | `.data/render3d`                     | scratch renders, file library (CLI / MCP)                                                               |
| `RENDER3D_CPU_POWER_W`, `RENDER3D_GPU_POWER_W`, `RENDER3D_ENERGY_USD_PER_KWH`, `RENDER3D_HARDWARE_USD`, `RENDER3D_HARDWARE_LIFETIME_HOURS`, `RENDER3D_EXTRA_USD_PER_HOUR` | 140 W, 380 W, 0.30, 2200, 8760 h, 0  | local cost assumptions                                                                                  |
| `UE_EDITOR_CMD`, `UE_PROJECT`, `UE_RENDER_TIMEOUT_MS`, `UE_REMOTE_EXEC_PORT`                                                                                              | –                                    | Unreal station (see [UNREAL_MCP_SETUP.md](UNREAL_MCP_SETUP.md))                                         |

## Local cost

`cost = hours × (power × energy price + hardware price / service life) + extra/h + external services`
(`packages/render3d/src/cost/local.ts`). Rendering locally is not free; LLM tokens are not added to renders
(production uses saved scripts only). Assumptions are reported next to every cost.

## CLI

```bash
pnpm --filter @cre/worker render3d:demo --test A|B|all [--quality preview|production]   # Test A / B
pnpm --filter @cre/worker render3d:reel [--quality preview]                              # Test D (E2E)
```
