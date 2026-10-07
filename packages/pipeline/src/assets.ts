import path from "node:path";
import {
  microsToDecimal,
  type Asset,
  type AssetKind,
  type AssetOrigin,
  type DbClient,
  type Prisma,
} from "@cre/db";
import { probeMedia } from "@cre/media";
import { assetStorageKey, contentTypeForExt } from "@cre/providers";
import { toJson, type Micros } from "@cre/shared";
import type { PipelineContext } from "./context.ts";

/** Asset persistence helpers: upload generated files to object storage and record provenance. */

export interface StoreAssetInput {
  asset: Pick<Asset, "id" | "workspaceId" | "brandId">;
  localPath: string;
  mimeType?: string;
}

export async function uploadAssetFile(ctx: PipelineContext, input: StoreAssetInput) {
  const ext = path.extname(input.localPath).replace(/^\./, "") || "bin";
  const contentType = input.mimeType ?? contentTypeForExt(ext);
  const key = assetStorageKey({
    workspaceId: input.asset.workspaceId,
    brandId: input.asset.brandId,
    assetId: input.asset.id,
    ext,
  });
  const stored = await ctx.media.storage.putFile(key, input.localPath, contentType);
  let dims: { width?: number; height?: number; durationMs?: number } = {};
  try {
    const info = await probeMedia(input.localPath);
    dims = {
      ...(info.width ? { width: info.width } : {}),
      ...(info.height ? { height: info.height } : {}),
      ...(info.durationMs && (info.hasVideo || info.hasAudio) && !contentType.startsWith("image/")
        ? { durationMs: info.durationMs }
        : {}),
    };
  } catch {
    // non-media files (e.g. subtitles) have no dimensions
  }
  return { ...stored, mimeType: contentType, ...dims };
}

export interface ReadyAssetData {
  provider: string;
  model: string;
  prompt?: string | null;
  negativePrompt?: string | null;
  params?: Record<string, unknown>;
  seed?: number | null;
  costMicros?: Micros | null;
  license: string;
  sourceUrl?: string | null;
  isMock: boolean;
  metadata?: Record<string, unknown>;
  /** lineage: assets this one was derived from */
  inputs?: { assetId: string; role: string }[];
}

export async function markAssetReady(
  ctx: PipelineContext,
  db: DbClient,
  asset: Pick<Asset, "id" | "workspaceId" | "brandId">,
  localPath: string,
  data: ReadyAssetData,
  mimeType?: string,
): Promise<Asset> {
  const file = await uploadAssetFile(ctx, { asset, localPath, ...(mimeType ? { mimeType } : {}) });
  const updated = await db.asset.update({
    where: { id: asset.id },
    data: {
      status: "READY",
      storageKey: file.key,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      checksum: file.checksum,
      width: file.width ?? null,
      height: file.height ?? null,
      durationMs: file.durationMs ?? null,
      provider: data.provider,
      model: data.model,
      prompt: data.prompt ?? null,
      negativePrompt: data.negativePrompt ?? null,
      ...(data.params ? { params: toJson(data.params) as Prisma.InputJsonValue } : {}),
      seed: data.seed ?? null,
      generationCostUsd:
        data.costMicros !== undefined && data.costMicros !== null ? microsToDecimal(data.costMicros) : null,
      license: data.license,
      sourceUrl: data.sourceUrl ?? null,
      isMock: data.isMock,
      ...(data.metadata ? { metadata: toJson(data.metadata) as Prisma.InputJsonValue } : {}),
      errorMessage: null,
    },
  });
  for (const input of data.inputs ?? []) {
    await db.assetInput.createMany({
      data: [{ assetId: asset.id, inputAssetId: input.assetId, role: input.role }],
      skipDuplicates: true,
    });
  }
  return updated;
}

export interface EnsureAssetRowInput {
  idempotencyKey: string;
  workspaceId: string;
  brandId: string | null;
  projectId: string | null;
  sceneId?: string | null;
  productId?: string | null;
  kind: AssetKind;
  origin: AssetOrigin;
  prompt?: string | null;
  params?: Record<string, unknown>;
  revision?: number;
}

/** Create the Asset row for a key if it does not exist (concurrency-safe). */
export async function ensureAssetRow(db: DbClient, input: EnsureAssetRowInput): Promise<Asset> {
  await db.asset.createMany({
    data: [
      {
        idempotencyKey: input.idempotencyKey,
        workspaceId: input.workspaceId,
        brandId: input.brandId,
        projectId: input.projectId,
        sceneId: input.sceneId ?? null,
        productId: input.productId ?? null,
        kind: input.kind,
        origin: input.origin,
        status: "PENDING",
        prompt: input.prompt ?? null,
        ...(input.params ? { params: toJson(input.params) as Prisma.InputJsonValue } : {}),
        revision: input.revision ?? 1,
      },
    ],
    skipDuplicates: true,
  });
  return db.asset.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
}

/** Local file path of a READY asset (downloads from remote storage when needed). */
export async function assetLocalPath(
  ctx: PipelineContext,
  asset: Pick<Asset, "id" | "storageKey">,
): Promise<string> {
  if (!asset.storageKey) throw new Error(`Asset ${asset.id} has no stored file`);
  return ctx.media.storage.getLocalPath(asset.storageKey);
}

/** Sum of committed/reserved cost recorded for an asset (for provenance display). */
export async function assetCostMicros(db: DbClient, assetId: string): Promise<Micros> {
  const rows = await db.generationUsage.findMany({
    where: { assetId, status: { in: ["COMMITTED", "RESERVED"] } },
  });
  return rows.reduce(
    (s, r) => s + Math.round(Number((r.actualCostUsd ?? r.estimatedCostUsd).toString()) * 1_000_000),
    0,
  );
}
