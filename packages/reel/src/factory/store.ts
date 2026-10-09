import fsp from "node:fs/promises";
import path from "node:path";
import type { ReelJob } from "../contracts/job.ts";
import type { ReelManifest } from "../contracts/manifest.ts";
import type { ReelPlan } from "../contracts/plan.ts";
import type { ProductProfile } from "../contracts/product.ts";

/**
 * Persistence port of the factory. The factory itself is storage-agnostic: the CLI uses the file store, the
 * worker a Prisma store (ReelJobRecord / ReelVariant / ProductProfileCache) — see apps/worker.
 */
export type ReelJobState = "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "BUDGET_BLOCKED";

export interface ReelStore {
  jobStarted(job: ReelJob, maxApiCostUsd: number): Promise<void>;
  jobFinished(
    jobId: string,
    state: ReelJobState,
    info: { totalApiCostUsd: number; timings: Record<string, number>; error?: string },
  ): Promise<void>;
  variantDelivered(manifest: ReelManifest, plan: ReelPlan): Promise<void>;
  /** cached product analysis (null on miss) */
  getProfile(productKey: string, sourceHash: string, analyzerVersion: string): Promise<ProductProfile | null>;
  putProfile(productKey: string, profile: ProductProfile, analyzerVersion: string): Promise<void>;
}

/** JSON files next to the outputs: <dir>/<jobId>/{job.json, <variantId>.manifest.json, <variantId>.plan.json}. */
export class FileReelStore implements ReelStore {
  constructor(readonly dir: string) {}

  private async write(rel: string, value: unknown): Promise<void> {
    const p = path.join(this.dir, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, JSON.stringify(value, null, 1));
  }

  async jobStarted(job: ReelJob, maxApiCostUsd: number): Promise<void> {
    await this.write(path.join(job.jobId, "job.json"), {
      job,
      maxApiCostUsd,
      state: "RUNNING",
      startedAt: new Date().toISOString(),
    });
  }

  async jobFinished(
    jobId: string,
    state: ReelJobState,
    info: { totalApiCostUsd: number; timings: Record<string, number>; error?: string },
  ): Promise<void> {
    const p = path.join(this.dir, jobId, "job.json");
    const prev = (await fsp.readFile(p, "utf8").then(JSON.parse, () => ({}))) as Record<string, unknown>;
    await this.write(path.join(jobId, "job.json"), {
      ...prev,
      state,
      ...info,
      finishedAt: new Date().toISOString(),
    });
  }

  async variantDelivered(manifest: ReelManifest, plan: ReelPlan): Promise<void> {
    await this.write(path.join(manifest.jobId, `${manifest.variantId}.manifest.json`), manifest);
    await this.write(path.join(manifest.jobId, `${manifest.variantId}.plan.json`), plan);
  }

  async getProfile(
    productKey: string,
    sourceHash: string,
    analyzerVersion: string,
  ): Promise<ProductProfile | null> {
    const p = path.join(this.dir, "_profiles", `${productKey}.${sourceHash}.${analyzerVersion}.json`);
    return (await fsp.readFile(p, "utf8").then(JSON.parse, () => null)) as ProductProfile | null;
  }

  async putProfile(productKey: string, profile: ProductProfile, analyzerVersion: string): Promise<void> {
    await this.write(
      path.join("_profiles", `${productKey}.${profile.sourceHash}.${analyzerVersion}.json`),
      profile,
    );
  }
}
