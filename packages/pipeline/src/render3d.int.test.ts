import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFromRoot, setEnvForTesting } from "@cre/config";
import { createPrismaClient, seedDatabase, type PrismaClient } from "@cre/db";
import { testDatabaseUrl, truncateAll } from "@cre/db/testing";
import { LocalStorageProvider } from "@cre/providers";
import { createLogger } from "@cre/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineContext } from "./context.ts";
import { PrismaAssetLibrary3D } from "./render3d-library.ts";
import { runJob } from "./runner.ts";
import { enqueueRender3d } from "./steps/render3d.ts";

/*
 * render3d.produce against a real PostgreSQL, the real job runner and — when a Python with bpy is available —
 * the real Blender scene generators (a tiny preview of the demo cosmetic tube): outbox → runner → router →
 * Blender → encode → clip QA → Storage + Render3DAsset + Asset mirror; then a cache hit, an approval, and a
 * render station that is offline (the job is parked, not failed).
 */

const BPY = resolveFromRoot(".tools/blender-venv/bin/python");
const hasBpy = (() => {
  try {
    execFileSync(BPY, ["-c", "import bpy"], { stdio: "ignore", timeout: 120_000 });
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let prisma: PrismaClient;
let tmp: string;
let workspaceId: string;

const recipe = {
  template: "PRODUCT_HERO",
  productAssetId: "demo-sunscreen-tube",
  durationSec: 0.5,
  fps: 24,
  resolution: [256, 456],
  camera: { preset: "orbit_closeup", movement: "slow" },
  background: { preset: "soft_pastel" },
};

function ctxWith(over: Record<string, string>) {
  const env = setEnvForTesting({
    MOCK_AI: "true",
    MOCK_MEDIA: "true",
    MOCK_SOCIAL: "true",
    PUBLISHING_ENABLED: "false",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: path.join(tmp, "storage"),
    WORK_DIR: path.join(tmp, "work"),
    REEL_CACHE_DIR: path.join(tmp, "cache"),
    RENDER3D_DATA_DIR: path.join(tmp, "render3d"),
    RENDER3D_DEVICE: "CPU",
    BLENDER_PYTHON: BPY,
    ...over,
  });
  return createPipelineContext({ env, prisma, logger: createLogger({ service: "test", level: "silent" }) });
}

beforeAll(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cre-render3d-"));
  prisma = createPrismaClient({ url: testDatabaseUrl() });
  await truncateAll(prisma);
  await prisma.render3DAsset.deleteMany();
  await prisma.renderStation.deleteMany();
  workspaceId = (await seedDatabase(prisma, { ownerEmail: "owner@test.local", ownerPassword: "password123" }))
    .workspaceId;
});

afterAll(async () => {
  await prisma.$disconnect();
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("render3d.produce job", () => {
  it("is enqueued once per render job id (transactional outbox)", async () => {
    const a = await enqueueRender3d(prisma, { jobId: "r3d-once", recipe, workspaceId });
    const b = await enqueueRender3d(prisma, { jobId: "r3d-once", recipe, workspaceId });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
  });

  it.skipIf(!hasBpy)(
    "renders with Blender, stores the clip (Storage + Render3DAsset + Asset), then reuses it",
    async () => {
      const ctx = ctxWith({});
      const job = await enqueueRender3d(prisma, {
        jobId: "r3d-tube-1",
        recipe,
        demoProduct: "demo-sunscreen-tube",
        workspaceId,
      });
      const out = await runJob(ctx, job.id);
      expect(out.status).toBe("succeeded");
      const row = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } });
      const result = row.result as { engine: string; assetId: string; reused: boolean; qaPassed: boolean };
      expect(result.engine).toBe("BLENDER");
      expect(result.reused).toBe(false);
      const lib = new PrismaAssetLibrary3D(
        prisma,
        new LocalStorageProvider(path.join(tmp, "storage")),
        workspaceId,
      );
      const clip = (await lib.get(result.assetId))!;
      expect(clip.assetType).toBe("RENDER_CLIP");
      expect(clip.isDemoOnly).toBe(true);
      expect(clip.engineVersion).toMatch(/^Blender \d/);
      expect(clip.telemetry?.framesRendered).toBe(8); // 0.5 s at the preview's 15 fps
      const db = await prisma.render3DAsset.findUniqueOrThrow({ where: { id: clip.assetId } });
      expect(db.recipeHash).toBe(clip.recipeHash);
      const mirror = await prisma.asset.findUniqueOrThrow({ where: { id: db.assetRowId! } });
      expect(mirror).toMatchObject({ kind: "VIDEO_CLIP", origin: "RENDERED", status: "READY", isMock: true });
      expect(fs.existsSync(path.join(tmp, "storage", mirror.storageKey!))).toBe(true);
      expect(await prisma.renderStation.count()).toBe(1);

      // the identical recipe in another job: library hit, Blender does not run
      const again = await enqueueRender3d(prisma, { jobId: "r3d-tube-2", recipe, workspaceId });
      expect((await runJob(ctx, again.id)).status).toBe("succeeded");
      const r2 = (await prisma.generationJob.findUniqueOrThrow({ where: { id: again.id } })).result as {
        engine: string;
        assetId: string;
        reused: boolean;
      };
      expect(r2).toMatchObject({ engine: "EXISTING_ASSET", reused: true, assetId: clip.assetId });

      // owner approval is recorded on the record and its column
      await lib.setApproval(clip.assetId, "APPROVED", "owner@test.local");
      expect(
        (await prisma.render3DAsset.findUniqueOrThrow({ where: { id: clip.assetId } })).approvalStatus,
      ).toBe("APPROVED");
    },
    600_000,
  );

  it("parks the job while the render station cannot render (attempt given back, resumable)", async () => {
    const ctx = ctxWith({ BLENDER_PYTHON: path.join(tmp, "no-such-python") });
    const job = await enqueueRender3d(prisma, {
      jobId: "r3d-offline",
      recipe: { ...recipe, seed: 99 },
      demoProduct: "demo-sunscreen-tube",
      workspaceId,
    });
    const out = await runJob(ctx, job.id);
    expect(out.status).toBe("retrying");
    const row = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("RETRYING");
    expect(row.attempts).toBe(0);
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
    const ev = await prisma.jobEvent.findFirst({ where: { jobId: job.id, type: "RETRY" } });
    expect(ev?.message).toMatch(/deferred/);
  });
});
