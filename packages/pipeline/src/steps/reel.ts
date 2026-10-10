import path from "node:path";
import { JOB_DEFAULTS, resolveFromRoot } from "@cre/config";
import { enqueueJob } from "@cre/core";
import type { DbClient } from "@cre/db";
import { createGoogleAI } from "@cre/providers";
import { ingestAboProduct, loadBrandProfile, loadProductSourceJson, ReelFactory, ReelJob } from "@cre/reel";
import { z } from "zod";
import type { JobExecution } from "../job-types.ts";
import { PrismaReelStore } from "../reel-store.ts";

/**
 * `reel.produce` — one product → a sales reel in every requested locale (+ A/B hooks), fully automatic.
 * The job payload names the product and brand by repo-relative path inside the allowed data roots only; the
 * whole production (director, Blender, audio, FFmpeg, QA, retries, manifests, DB rows) runs in ReelFactory.
 */

const PRODUCTS_ROOT = ".data/products";
const BRANDS_ROOT = "assets/brands";

export const ReelProducePayload = z.object({
  /** a ReelJob (validated by ReelJob.parse) */
  job: z.unknown(),
  product: z.object({ kind: z.enum(["abo", "json"]), path: z.string().min(1).max(300) }),
  brandPath: z.string().min(1).max(300),
});

/** a payload path must stay inside its data root (no traversal, no absolute paths) */
export function safeDataPath(rel: string, root: string): string {
  const abs = resolveFromRoot(rel);
  const base = resolveFromRoot(root);
  if (path.isAbsolute(rel) || !abs.startsWith(`${base}${path.sep}`))
    throw new Error(`path outside ${root}: ${rel}`);
  return abs;
}

export async function reelProduceHandler(exec: JobExecution): Promise<Record<string, unknown>> {
  const p = ReelProducePayload.parse(exec.payload);
  const job = ReelJob.parse(p.job);
  const productPath = safeDataPath(p.product.path, PRODUCTS_ROOT);
  const source =
    p.product.kind === "abo" ? await ingestAboProduct(productPath) : loadProductSourceJson(productPath);
  const brand = loadBrandProfile(safeDataPath(p.brandPath, BRANDS_ROOT));
  const env = exec.ctx.env;
  const googleAI =
    env.GOOGLE_API_KEY || env.GOOGLE_CLOUD_ACCESS_TOKEN ? createGoogleAI(env, { logger: exec.log }) : null;
  const factory = new ReelFactory({
    env,
    store: new PrismaReelStore(exec.ctx.prisma, exec.job.workspaceId),
    logger: exec.log,
    googleAI,
  });
  // Blender may use 60 % of the job timeout; a QUALITY plan that cannot fit is rendered with FAST instead of
  // being killed at the timeout (and re-rendered from zero by the retry)
  const timeoutMs = JOB_DEFAULTS["reel.produce"]?.timeoutMs ?? 3_600_000;
  const result = await factory.produce(
    { job, source, brand },
    { signal: exec.signal, studioBudgetMs: Math.round(timeoutMs * 0.6) },
  );
  return {
    jobId: result.jobId,
    totalApiCostUsd: result.totalApiCostUsd,
    bottleneck: result.bottleneck,
    variants: result.variants.map((v) => ({
      variantId: v.variantId,
      locale: v.locale,
      video: v.video,
      qaScore: v.manifest.qa.score,
      qaPassed: v.manifest.qa.passed,
    })),
  };
}

/** Enqueue a reel production through the transactional outbox (idempotent per reel job id). */
export async function enqueueReelProduction(
  db: DbClient,
  input: z.infer<typeof ReelProducePayload> & { workspaceId?: string | null },
): Promise<{ id: string; created: boolean }> {
  const job = ReelJob.parse(input.job);
  safeDataPath(input.product.path, PRODUCTS_ROOT);
  safeDataPath(input.brandPath, BRANDS_ROOT);
  return enqueueJob(db, {
    type: "reel.produce",
    payload: { job, product: input.product, brandPath: input.brandPath },
    idempotencyKey: `reel.produce:${job.jobId}`,
    workspaceId: input.workspaceId ?? null,
  });
}
