import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { sha256Hex, stableStringify } from "@cre/shared";

/**
 * Content-addressed cache on the local filesystem. Everything reusable (renders, music, TTS, SFX, profiles,
 * translations, embeddings, director results) is keyed by a hash of ALL inputs that affect the output, including
 * a version tag of the code / model that produced it — so a cache hit is always safe to reuse.
 *
 *   <cacheDir>/<namespace>/<key[0..2]>/<key>/<files…>
 */
export function cacheKey(namespace: string, version: string, inputs: unknown): string {
  return sha256Hex(stableStringify({ namespace, version, inputs })).slice(0, 40);
}

export class FileCache {
  constructor(readonly root: string) {}

  dir(namespace: string, key: string): string {
    return path.join(this.root, namespace, key.slice(0, 2), key);
  }

  /** path of a cached file (may not exist) */
  file(namespace: string, key: string, name: string): string {
    return path.join(this.dir(namespace, key), name);
  }

  has(namespace: string, key: string, name: string): boolean {
    const p = this.file(namespace, key, name);
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  }

  /**
   * Returns the cached file, or produces it with `make(tmpPath)` and atomically moves it into place.
   * `hit` tells the caller whether work (and cost) was avoided.
   */
  async getOrCreate(
    namespace: string,
    key: string,
    name: string,
    make: (tmpPath: string) => Promise<void>,
  ): Promise<{ path: string; hit: boolean }> {
    const final = this.file(namespace, key, name);
    if (this.has(namespace, key, name)) return { path: final, hit: true };
    await fsp.mkdir(path.dirname(final), { recursive: true });
    const tmp = `${final}.tmp-${process.pid}-${Date.now()}${path.extname(name)}`;
    try {
      await make(tmp);
      await fsp.rename(tmp, final);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
    return { path: final, hit: false };
  }

  async readJson<T>(namespace: string, key: string, name = "data.json"): Promise<T | undefined> {
    const p = this.file(namespace, key, name);
    try {
      return JSON.parse(await fsp.readFile(p, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  async writeJson(namespace: string, key: string, value: unknown, name = "data.json"): Promise<string> {
    const p = this.file(namespace, key, name);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 1));
    await fsp.rename(tmp, p);
    return p;
  }
}

/** sha256 of a file's bytes (render cache keys include the product model / input files) */
export async function fileSha256(p: string): Promise<string> {
  const buf = await fsp.readFile(p);
  return sha256Hex(buf);
}
