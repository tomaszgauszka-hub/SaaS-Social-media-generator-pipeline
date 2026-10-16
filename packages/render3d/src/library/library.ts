import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { StorageProvider } from "@cre/providers";
import { contentTypeForExt } from "@cre/providers";
import {
  Asset3D,
  type ApprovalStatus,
  type Asset3DInput,
  type AssetType3D,
  type OutputRole,
} from "../contracts/asset.ts";
import { fileSha256 } from "../cache/keys.ts";
import type { TimingSample } from "../routing/estimate.ts";
import type { LibraryLookup } from "../routing/router.ts";

/*
 * 3D asset library: metadata records + files in the Storage provider (never binaries in a database row).
 *
 * Files are content-addressed for deduplication: before a file is stored its sha256 is looked up, and an
 * identical file already in the library is referenced instead of copied. Clips are found by recipe hash
 * (exact cache hit) or visual key (same recipe from another engine version).
 */

export interface LibraryFile {
  role: OutputRole;
  localPath: string;
  contentType?: string;
}

export interface LibraryFilter {
  assetType?: AssetType3D;
  productId?: string;
  approval?: ApprovalStatus;
  limit?: number;
}

export interface AssetLibrary3D extends LibraryLookup {
  get(assetId: string): Promise<Asset3D | null>;
  list(filter?: LibraryFilter): Promise<Asset3D[]>;
  /** newest model of a product that the owner has not rejected */
  findProductModel(productId: string): Promise<Asset3D | null>;
  put(asset: Asset3DInput, files?: readonly LibraryFile[]): Promise<Asset3D>;
  setApproval(assetId: string, status: ApprovalStatus, by: string, note?: string): Promise<Asset3D>;
  /** local path of one of the asset's files (downloads from remote storage into its cache) */
  localPath(asset: Asset3D, role: OutputRole): Promise<string | null>;
  timingHistory(): Promise<TimingSample[]>;
}

export function storageKeyFor(
  asset: Pick<Asset3D, "assetType" | "assetId">,
  role: OutputRole,
  ext: string,
): string {
  return `render3d/${asset.assetType.toLowerCase()}/${asset.assetId}/${role}${ext}`;
}

/** Store the files of an asset (dedup by sha256 against `known`) and return the outputFiles records. */
export async function storeFiles(
  storage: StorageProvider,
  asset: Pick<Asset3D, "assetType" | "assetId">,
  files: readonly LibraryFile[],
  known: (sha: string) => Promise<{ key: string; sizeBytes: number; contentType: string } | null>,
): Promise<Asset3D["outputFiles"]> {
  const out: Asset3D["outputFiles"] = [];
  for (const f of files) {
    const sha = fileSha256(f.localPath);
    const ext = path.extname(f.localPath).toLowerCase();
    const contentType = f.contentType ?? contentTypeForExt(ext);
    const dup = await known(sha);
    if (dup && (await storage.exists(dup.key))) {
      out.push({
        role: f.role,
        key: dup.key,
        sizeBytes: dup.sizeBytes,
        sha256: sha,
        contentType: dup.contentType,
      });
      continue;
    }
    const stored = await storage.putFile(storageKeyFor(asset, f.role, ext), f.localPath, contentType);
    out.push({ role: f.role, key: stored.key, sizeBytes: stored.sizeBytes, sha256: sha, contentType });
  }
  return out;
}

export function timingFromAsset(a: Asset3D): TimingSample | null {
  const t = a.telemetry;
  if (!t || a.assetType !== "RENDER_CLIP" || !a.resolution || !t.perFrameMsMedian || t.cacheHit) return null;
  const engine = t.engine === "unreal" ? "unreal" : t.engine === "blender" ? "blender" : null;
  if (!engine || !a.quality) return null;
  const samples = a.quality === "preview" ? 16 : 64;
  const mp = (a.resolution[0] * a.resolution[1]) / 1e6;
  const unitMs = engine === "blender" ? t.perFrameMsMedian / (mp * samples) : t.perFrameMsMedian;
  return { engine, device: t.device === "GPU" ? "GPU" : "CPU", quality: a.quality, unitMs };
}

/** File-backed library: one JSON record per asset under <root>/assets, files in the Storage provider. */
export class FileAssetLibrary implements AssetLibrary3D {
  private readonly dir: string;

  constructor(
    root: string,
    private readonly storage: StorageProvider,
  ) {
    this.dir = path.join(root, "assets");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(assetId: string): string {
    return path.join(this.dir, `${Asset3D.shape.assetId.parse(assetId)}.json`);
  }

  private async all(): Promise<Asset3D[]> {
    const names = (await fsp.readdir(this.dir)).filter((f) => f.endsWith(".json"));
    const out: Asset3D[] = [];
    for (const n of names) {
      try {
        out.push(Asset3D.parse(JSON.parse(await fsp.readFile(path.join(this.dir, n), "utf8"))));
      } catch {
        /* a corrupt record is skipped, never trusted */
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(assetId: string): Promise<Asset3D | null> {
    try {
      return Asset3D.parse(JSON.parse(await fsp.readFile(this.file(assetId), "utf8")));
    } catch {
      return null;
    }
  }

  async list(filter: LibraryFilter = {}): Promise<Asset3D[]> {
    const rows = (await this.all()).filter(
      (a) =>
        (!filter.assetType || a.assetType === filter.assetType) &&
        (!filter.productId || a.productId === filter.productId) &&
        (!filter.approval || a.approval.status === filter.approval),
    );
    return filter.limit ? rows.slice(-filter.limit) : rows;
  }

  async findByRecipeHash(hash: string): Promise<Asset3D | null> {
    return (
      (await this.all()).findLast((a) => a.recipeHash === hash && a.approval.status !== "REJECTED") ?? null
    );
  }

  async findByVisualKey(key: string): Promise<Asset3D | null> {
    return (
      (await this.all()).findLast((a) => a.visualKey === key && a.approval.status !== "REJECTED") ?? null
    );
  }

  async findProductModel(productId: string): Promise<Asset3D | null> {
    const models = (await this.all()).filter(
      (a) => a.assetType === "PRODUCT_MODEL" && a.productId === productId && a.approval.status !== "REJECTED",
    );
    return models.sort((a, b) => a.version - b.version).at(-1) ?? null;
  }

  async put(input: Asset3DInput, files: readonly LibraryFile[] = []): Promise<Asset3D> {
    const draft = Asset3D.parse(input);
    const all = await this.all();
    const stored = await storeFiles(this.storage, draft, files, (sha) => {
      for (const a of all) {
        const f = a.outputFiles.find((o) => o.sha256 === sha);
        if (f) return Promise.resolve(f);
      }
      return Promise.resolve(null);
    });
    const roles = new Set(stored.map((f) => f.role));
    const asset = Asset3D.parse({
      ...draft,
      outputFiles: [...draft.outputFiles.filter((f) => !roles.has(f.role)), ...stored],
    });
    const tmp = `${this.file(asset.assetId)}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(asset, null, 2));
    await fsp.rename(tmp, this.file(asset.assetId));
    return asset;
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
    return (await this.all()).map(timingFromAsset).filter((t): t is TimingSample => t !== null);
  }
}
