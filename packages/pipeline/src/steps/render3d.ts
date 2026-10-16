import os from "node:os";
import { JOB_DEFAULTS } from "@cre/config";
import { enqueueJob } from "@cre/core";
import type { DbClient } from "@cre/db";
import { SafeId } from "@cre/reel/contracts";
import { createRender3D, DEMO_PRODUCTS, Recipe3D, registerDemoProduct } from "@cre/render3d";
import { z } from "zod";
import type { JobExecution } from "../job-types.ts";
import { PrismaAssetLibrary3D, renderStationHeartbeat } from "../render3d-library.ts";

/**
 * `render3d.produce` — one recipe → one 3D clip in the library (or a reused one), run by the local render
 * station without any LLM: router → Blender / Unreal → encode → QA → Storage + DB. A station that is offline or
 * busy defers the job (parked, no attempt used); the job never publishes anything.
 */

export const Render3DProducePayload = z.object({
  jobId: SafeId,
  recipe: z.unknown(),
  valueScore: z.number().min(0).max(1).optional(),
  brandId: z.string().max(120).nullable().optional(),
  /** register one of the repo's DEMO_ONLY procedural products first */
  demoProduct: z.enum(Object.keys(DEMO_PRODUCTS) as [string, ...string[]]).optional(),
});
export type Render3DProducePayload = z.infer<typeof Render3DProducePayload>;

export async function render3dProduceHandler(exec: JobExecution): Promise<Record<string, unknown>> {
  const p = Render3DProducePayload.parse(exec.payload);
  const recipe = Recipe3D.parse(p.recipe);
  const env = exec.ctx.env;
  const library = new PrismaAssetLibrary3D(exec.ctx.prisma, exec.ctx.media.storage, exec.job.workspaceId);
  const setup = createRender3D(env, { library, storage: exec.ctx.media.storage });
  if (p.demoProduct) await registerDemoProduct(library, p.demoProduct);
  const station = os.hostname();
  const caps = await setup.worker.capabilities();
  await renderStationHeartbeat(exec.ctx.prisma, station, caps, 1);
  const timeoutMs = Math.round((JOB_DEFAULTS["render3d.produce"]?.timeoutMs ?? 4 * 3_600_000) * 0.9);
  let lastLog = 0;
  try {
    const r = await setup.worker.run(
      {
        jobId: p.jobId,
        recipe,
        ...(p.valueScore !== undefined ? { valueScore: p.valueScore } : {}),
        brandId: p.brandId ?? null,
        requireApprovedPreview: env.RENDER3D_REQUIRE_APPROVED_PREVIEW,
      },
      {
        signal: exec.signal,
        timeoutMs,
        onProgress: (frame, total) => {
          if (Date.now() - lastLog > 15_000 || frame === total) {
            lastLog = Date.now();
            exec.log.info({ frame, total }, "render3d progress");
          }
        },
      },
    );
    return {
      engine: r.decision.engine,
      reasons: r.decision.reasons,
      assetId: r.asset?.assetId ?? null,
      reused: r.reused,
      qaPassed: r.qa?.passed ?? null,
      qaScore: r.qa?.score ?? null,
      costUsd: r.cost?.usd ?? 0,
      renderMs: r.telemetry?.renderDurationMs ?? 0,
    };
  } finally {
    await renderStationHeartbeat(
      exec.ctx.prisma,
      station,
      caps as unknown as Record<string, unknown>,
      0,
    ).catch(() => undefined);
  }
}

/** Enqueue a 3D render through the transactional outbox (idempotent per render job id). */
export async function enqueueRender3d(
  db: DbClient,
  input: Render3DProducePayload & { workspaceId?: string | null },
): Promise<{ id: string; created: boolean }> {
  const p = Render3DProducePayload.parse(input);
  Recipe3D.parse(p.recipe);
  return enqueueJob(db, {
    type: "render3d.produce",
    payload: p,
    idempotencyKey: `render3d.produce:${p.jobId}`,
    workspaceId: input.workspaceId ?? null,
  });
}
