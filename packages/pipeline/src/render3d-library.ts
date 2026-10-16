import type { Prisma, PrismaClient } from "@cre/db";
import type { StorageProvider } from "@cre/providers";
import {
  Asset3D,
  storeFiles,
  timingFromAsset,
  type ApprovalStatus,
  type Asset3DInput,
  type AssetLibrary3D,
  type LibraryFile,
  type LibraryFilter,
  type OutputRole,
  type TimingSample,
} from "@cre/render3d";

/*
 * 3D asset library backed by PostgreSQL (metadata) + the Storage provider (files). Every record is validated by
 * the render3d contract on read — a row is never trusted as is. A rendered clip is also mirrored into the app's
 * existing Asset table (kind VIDEO_CLIP, origin RENDERED), so the dashboards, storage proxy and cleanup that
 * already work with assets see 3D clips without special cases. Demo-only clips are flagged isMock (never
 * production content).
 */

export class PrismaAssetLibrary3D implements AssetLibrary3D {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: StorageProvider,
    private readonly workspaceId: string | null,
  ) {}

  private parse(row: { record: Prisma.JsonValue } | null): Asset3D | null {
    if (!row) return null;
    const r = Asset3D.safeParse(row.record);
    return r.success ? r.data : null;
  }

  async get(assetId: string): Promise<Asset3D | null> {
    return this.parse(await this.prisma.render3DAsset.findUnique({ where: { id: assetId } }));
  }

  async list(filter: LibraryFilter = {}): Promise<Asset3D[]> {
    const rows = await this.prisma.render3DAsset.findMany({
      where: {
        ...(filter.assetType ? { assetType: filter.assetType } : {}),
        ...(filter.productId ? { productId: filter.productId } : {}),
        ...(filter.approval ? { approvalStatus: filter.approval } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: filter.limit ?? 200,
    });
    return rows
      .map((r) => this.parse(r))
      .filter((a): a is Asset3D => a !== null)
      .reverse();
  }

  async findByRecipeHash(hash: string): Promise<Asset3D | null> {
    return this.parse(
      await this.prisma.render3DAsset.findFirst({
        where: { recipeHash: hash, approvalStatus: { not: "REJECTED" } },
        orderBy: { createdAt: "desc" },
      }),
    );
  }

  async findByVisualKey(key: string): Promise<Asset3D | null> {
    return this.parse(
      await this.prisma.render3DAsset.findFirst({
        where: { visualKey: key, approvalStatus: { not: "REJECTED" } },
        orderBy: { createdAt: "desc" },
      }),
    );
  }

  async findProductModel(productId: string): Promise<Asset3D | null> {
    return this.parse(
      await this.prisma.render3DAsset.findFirst({
        where: { productId, assetType: "PRODUCT_MODEL", approvalStatus: { not: "REJECTED" } },
        orderBy: { version: "desc" },
      }),
    );
  }

  async put(input: Asset3DInput, files: readonly LibraryFile[] = []): Promise<Asset3D> {
    const draft = Asset3D.parse(input);
    const stored = await storeFiles(this.storage, draft, files, async (sha) => {
      // dedup: the same bytes already stored for any asset (outputFiles is JSON inside record)
      const hit = await this.prisma.$queryRaw<
        { f: { key: string; sizeBytes: number; contentType: string } }[]
      >`
        SELECT f FROM "Render3DAsset", jsonb_array_elements("record"->'outputFiles') AS f
        WHERE f->>'sha256' = ${sha} LIMIT 1`;
      return hit[0]?.f ?? null;
    });
    const roles = new Set(stored.map((f) => f.role));
    const asset = Asset3D.parse({
      ...draft,
      outputFiles: [...draft.outputFiles.filter((f) => !roles.has(f.role)), ...stored],
    });
    const assetRowId =
      asset.assetType === "RENDER_CLIP" && this.workspaceId ? await this.mirrorClip(asset) : null;
    const data = {
      workspaceId: this.workspaceId,
      assetType: asset.assetType,
      productId: asset.productId,
      brandId: asset.brandId,
      category: asset.category,
      source: asset.source,
      license: asset.license,
      fidelity: asset.fidelity,
      isDemoOnly: asset.isDemoOnly,
      isProductVerified: asset.isProductVerified,
      structureVerified: asset.structureVerified,
      engine: asset.engine,
      engineVersion: asset.engineVersion,
      version: asset.version,
      recipeHash: asset.recipeHash,
      visualKey: asset.visualKey,
      approvalStatus: asset.approval.status,
      record: asset as unknown as Prisma.InputJsonValue,
      ...(assetRowId ? { assetRowId } : {}),
    };
    await this.prisma.render3DAsset.upsert({
      where: { id: asset.assetId },
      create: { id: asset.assetId, ...data },
      update: data,
    });
    return asset;
  }

  /** The clip's video as a row of the existing asset system (idempotent per clip id). */
  private async mirrorClip(a: Asset3D): Promise<string | null> {
    const video = a.outputFiles.find((f) => f.role === "video");
    if (!video || !this.workspaceId) return null;
    const row = await this.prisma.asset.upsert({
      where: { idempotencyKey: `render3d:${a.assetId}` },
      create: {
        workspaceId: this.workspaceId,
        brandId: null,
        kind: "VIDEO_CLIP",
        status: "READY",
        origin: "RENDERED",
        storageKey: video.key,
        mimeType: video.contentType,
        width: a.resolution?.[0] ?? null,
        height: a.resolution?.[1] ?? null,
        durationMs: a.durationMs,
        sizeBytes: video.sizeBytes,
        checksum: video.sha256,
        provider: a.engine,
        model: a.engineVersion,
        params: { template: a.template, materialType: a.materialType, quality: a.quality },
        generationCostUsd: 0,
        isMock: a.isDemoOnly,
        license: a.license,
        licenseMetadata: { evidence: a.licenseEvidence, fidelity: a.fidelity, source: a.source },
        metadata: {
          render3dAssetId: a.assetId,
          recipeHash: a.recipeHash,
          renderCostEstimateUsd: a.renderCostEstimateUsd,
        },
        idempotencyKey: `render3d:${a.assetId}`,
      },
      update: { storageKey: video.key, checksum: video.sha256, sizeBytes: video.sizeBytes, status: "READY" },
    });
    return row.id;
  }

  async setApproval(assetId: string, status: ApprovalStatus, by: string, note?: string): Promise<Asset3D> {
    const a = await this.get(assetId);
    if (!a) throw new Error(`unknown 3D asset ${assetId}`);
    return this.put({ ...a, approval: { status, by, at: new Date().toISOString(), note: note ?? null } });
  }

  async localPath(asset: Asset3D, role: OutputRole): Promise<string | null> {
    const f = asset.outputFiles.find((o) => o.role === role);
    return f ? this.storage.getLocalPath(f.key) : null;
  }

  async timingHistory(): Promise<TimingSample[]> {
    return (await this.list({ assetType: "RENDER_CLIP", limit: 100 }))
      .map(timingFromAsset)
      .filter((t): t is TimingSample => t !== null);
  }
}

/** Upsert this host's render-station heartbeat (capabilities + active jobs). */
export async function renderStationHeartbeat(
  prisma: PrismaClient,
  id: string,
  capabilities: Record<string, unknown>,
  activeJobs: number,
  now = new Date(),
): Promise<void> {
  const caps = capabilities as Prisma.InputJsonValue;
  await prisma.renderStation.upsert({
    where: { id },
    create: { id, lastSeenAt: now, capabilities: caps, activeJobs },
    update: { lastSeenAt: now, capabilities: caps, activeJobs },
  });
}

/** Stations seen in the last `maxAgeMs` (default 2 min) — "online" for the router and the panel. */
export async function onlineRenderStations(prisma: PrismaClient, maxAgeMs = 120_000, now = new Date()) {
  return prisma.renderStation.findMany({
    where: { lastSeenAt: { gte: new Date(now.getTime() - maxAgeMs) } },
  });
}
