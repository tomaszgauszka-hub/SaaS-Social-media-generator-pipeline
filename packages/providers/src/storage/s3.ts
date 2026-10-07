import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ProviderHealth } from "../types.ts";
import { assertSafeKey, type ByteRange, type StorageProvider, type StoredObject } from "./types.ts";

export interface S3StorageOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  /** local cache for getLocalPath (FFmpeg needs files) */
  cacheDir: string;
}

/**
 * S3-compatible object storage: Cloudflare R2 (recommended: no egress fees), AWS S3, MinIO.
 * R2: endpoint https://<account>.r2.cloudflarestorage.com, region "auto".
 */
export class S3StorageProvider implements StorageProvider {
  readonly driver = "s3" as const;
  private readonly client: S3Client;

  constructor(private readonly opts: S3StorageOptions) {
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      forcePathStyle: opts.forcePathStyle ?? false,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async putFile(key: string, localPath: string, contentType: string): Promise<StoredObject> {
    assertSafeKey(key);
    const data = await fs.promises.readFile(localPath);
    return this.putBuffer(key, data, contentType);
  }

  async putBuffer(key: string, data: Buffer, contentType: string): Promise<StoredObject> {
    assertSafeKey(key);
    const checksum = createHash("sha256").update(data).digest("hex");
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        Metadata: { sha256: checksum },
      }),
    );
    return { key, sizeBytes: data.length, checksum, contentType };
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async stat(key: string): Promise<{ sizeBytes: number; contentType?: string } | null> {
    assertSafeKey(key);
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return {
        sizeBytes: Number(head.ContentLength ?? 0),
        ...(head.ContentType ? { contentType: head.ContentType } : {}),
      };
    } catch (err) {
      if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async getLocalPath(key: string): Promise<string> {
    assertSafeKey(key);
    const local = path.join(this.opts.cacheDir, key);
    const remote = await this.stat(key);
    if (!remote) throw new Error(`Object not found: ${key}`);
    try {
      const st = await fs.promises.stat(local);
      if (st.size === remote.sizeBytes) return local;
    } catch {
      // not cached yet
    }
    await fs.promises.mkdir(path.dirname(local), { recursive: true });
    const obj = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    const tmp = `${local}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await pipeline(obj.Body as Readable, fs.createWriteStream(tmp));
      await fs.promises.rename(tmp, local);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true });
      throw err;
    }
    return local;
  }

  async createReadStream(key: string, range?: ByteRange): Promise<Readable> {
    assertSafeKey(key);
    const obj = await this.client.send(
      new GetObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }),
    );
    return obj.Body as Readable;
  }

  async getSignedUrl(key: string, ttlSec: number): Promise<string | null> {
    assertSafeKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }), {
      expiresIn: ttlSec,
    });
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }

  async healthCheck(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
      return { ok: true, provider: "s3", kind: "storage", isMock: false, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, provider: "s3", kind: "storage", isMock: false, message: String(err) };
    }
  }
}
