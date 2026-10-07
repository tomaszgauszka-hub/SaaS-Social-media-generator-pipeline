import type { Readable } from "node:stream";
import type { ProviderHealth } from "../types.ts";

/**
 * Object storage abstraction. Large media never goes into PostgreSQL; rows keep only the storage key.
 * Keys are POSIX-style relative paths, e.g. "ws/<workspace>/brand/<brand>/assets/<asset>.mp4".
 */
export interface StoredObject {
  key: string;
  sizeBytes: number;
  checksum: string;
  contentType: string;
}

export interface ByteRange {
  start: number;
  end: number;
}

export interface StorageProvider {
  readonly driver: "local" | "s3";
  putFile(key: string, localPath: string, contentType: string): Promise<StoredObject>;
  putBuffer(key: string, data: Buffer, contentType: string): Promise<StoredObject>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<{ sizeBytes: number; contentType?: string } | null>;
  /** Local file path for the object (downloads to a cache for remote drivers). */
  getLocalPath(key: string): Promise<string>;
  createReadStream(key: string, range?: ByteRange): Promise<Readable>;
  /** Time-limited public URL (remote drivers) — null when the app must proxy the file itself. */
  getSignedUrl(key: string, ttlSec: number): Promise<string | null>;
  delete(key: string): Promise<void>;
  healthCheck(): Promise<ProviderHealth>;
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

/** Reject keys that could escape the storage root or contain odd characters. */
export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}

export function contentTypeForExt(ext: string): string {
  switch (ext.toLowerCase().replace(/^\./, "")) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "m4a":
      return "audio/mp4";
    case "ass":
      return "text/x-ssa";
    case "json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

export function assetStorageKey(parts: {
  workspaceId: string;
  brandId?: string | null;
  assetId: string;
  ext: string;
}): string {
  const ext = parts.ext.replace(/^\./, "");
  return parts.brandId
    ? `ws/${parts.workspaceId}/brand/${parts.brandId}/assets/${parts.assetId}.${ext}`
    : `ws/${parts.workspaceId}/assets/${parts.assetId}.${ext}`;
}
