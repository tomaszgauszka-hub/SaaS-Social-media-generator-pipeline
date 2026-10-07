import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ProviderError } from "@cre/shared";

/** Combine a caller's AbortSignal with a timeout. */
export function timeoutSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Fetch JSON from a provider API, mapping failures to ProviderError (status-aware retryability).
 * Never logs request bodies or auth headers.
 */
export async function requestJson<T>(
  provider: string,
  url: string,
  init: RequestInit,
  opts: RequestOptions = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: timeoutSignal(opts.timeoutMs ?? 60_000, opts.signal) });
  } catch (err) {
    throw new ProviderError(provider, `network error calling ${safeUrl(url)}: ${(err as Error).message}`, {
      cause: err,
      retryable: true,
    });
  }
  const text = await res.text();
  if (!res.ok) {
    throw new ProviderError(provider, `HTTP ${res.status} from ${safeUrl(url)}: ${text.slice(0, 500)}`, {
      status: res.status,
    });
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new ProviderError(provider, `invalid JSON from ${safeUrl(url)}`, { cause: err, retryable: true });
  }
}

/** Fetch binary content (e.g. TTS audio). */
export async function requestBinary(
  provider: string,
  url: string,
  init: RequestInit,
  opts: RequestOptions = {},
): Promise<{ data: Buffer; contentType: string }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: timeoutSignal(opts.timeoutMs ?? 60_000, opts.signal) });
  } catch (err) {
    throw new ProviderError(provider, `network error calling ${safeUrl(url)}: ${(err as Error).message}`, {
      cause: err,
      retryable: true,
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(provider, `HTTP ${res.status} from ${safeUrl(url)}: ${text.slice(0, 500)}`, {
      status: res.status,
    });
  }
  return {
    data: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}

/** Stream a remote file to disk with a size limit. */
export async function downloadToFile(
  provider: string,
  url: string,
  dest: string,
  opts: RequestOptions & { maxBytes?: number } = {},
): Promise<{ sizeBytes: number; contentType: string }> {
  const res = await fetch(url, { signal: timeoutSignal(opts.timeoutMs ?? 120_000, opts.signal) }).catch(
    (err: unknown) => {
      throw new ProviderError(provider, `download failed: ${(err as Error).message}`, {
        cause: err,
        retryable: true,
      });
    },
  );
  if (!res.ok || !res.body) {
    throw new ProviderError(provider, `download HTTP ${res.status} from ${safeUrl(url)}`, {
      status: res.status,
    });
  }
  const max = opts.maxBytes ?? 300 * 1024 * 1024;
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > max)
    throw new ProviderError(provider, `download too large (${declared} bytes)`, { retryable: false });
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  let total = 0;
  await pipeline(
    Readable.fromWeb(res.body as never),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        total += chunk.length;
        if (total > max)
          throw new ProviderError(provider, "download exceeded size limit", { retryable: false });
        yield chunk;
      }
    },
    fs.createWriteStream(dest),
  );
  return { sizeBytes: total, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
}

/** Strip query strings (may contain signatures/tokens) before putting URLs in errors/logs. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<invalid url>";
  }
}

/** data: URI for small local files (lets remote APIs read an image without public hosting). */
export async function fileToDataUri(filePath: string, mimeType: string): Promise<string> {
  const data = await fs.promises.readFile(filePath);
  return `data:${mimeType};base64,${data.toString("base64")}`;
}
