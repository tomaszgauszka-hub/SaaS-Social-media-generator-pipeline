import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ProviderHealth } from "../types.ts";
import { assertSafeKey, type ByteRange, type StorageProvider, type StoredObject } from "./types.ts";

/** Development storage on the local filesystem. Files are served by the web app via /api/media. */
export class LocalStorageProvider implements StorageProvider {
  readonly driver = "local" as const;

  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep))
      throw new Error(`Key escapes storage root: ${key}`);
    return full;
  }

  async putFile(key: string, localPath: string, contentType: string): Promise<StoredObject> {
    const dest = this.resolve(key);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const hash = createHash("sha256");
    const tmp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await pipeline(
        fs.createReadStream(localPath),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            hash.update(chunk);
            yield chunk;
          }
        },
        fs.createWriteStream(tmp),
      );
      await fs.promises.rename(tmp, dest);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true });
      throw err;
    }
    const st = await fs.promises.stat(dest);
    return { key, sizeBytes: st.size, checksum: hash.digest("hex"), contentType };
  }

  async putBuffer(key: string, data: Buffer, contentType: string): Promise<StoredObject> {
    const dest = this.resolve(key);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, data);
    return {
      key,
      sizeBytes: data.length,
      checksum: createHash("sha256").update(data).digest("hex"),
      contentType,
    };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.promises.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const st = await fs.promises.stat(this.resolve(key));
      return { sizeBytes: st.size };
    } catch {
      return null;
    }
  }

  getLocalPath(key: string): Promise<string> {
    return Promise.resolve(this.resolve(key));
  }

  createReadStream(key: string, range?: ByteRange): Promise<Readable> {
    const file = this.resolve(key);
    return Promise.resolve(
      range ? fs.createReadStream(file, { start: range.start, end: range.end }) : fs.createReadStream(file),
    );
  }

  getSignedUrl(): Promise<string | null> {
    return Promise.resolve(null);
  }

  async delete(key: string): Promise<void> {
    await fs.promises.rm(this.resolve(key), { force: true });
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      await fs.promises.mkdir(this.root, { recursive: true });
      await fs.promises.access(this.root, fs.constants.W_OK);
      return { ok: true, provider: "local", kind: "storage", isMock: false, message: this.root };
    } catch (err) {
      return { ok: false, provider: "local", kind: "storage", isMock: false, message: String(err) };
    }
  }
}
