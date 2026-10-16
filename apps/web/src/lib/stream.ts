import { Readable } from "node:stream";
import type { StorageProvider } from "@cre/providers";

/**
 * Stream one Storage object to the browser with HTTP Range support (Safari / iOS need it for <video>); remote
 * storage redirects to a short-lived signed URL. The key must come from a database record — never from the
 * request. Same behaviour as /api/assets/[id].
 */
export async function streamStorageObject(
  request: Request,
  store: StorageProvider,
  key: string,
  contentType: string | null,
): Promise<Response> {
  if (store.driver === "s3") {
    const url = await store.getSignedUrl(key, 300);
    if (url) return Response.redirect(url, 302);
  }
  const stat = await store.stat(key);
  if (!stat) return new Response("Not found", { status: 404 });
  const size = stat.sizeBytes;
  const headers: Record<string, string> = {
    "Content-Type": contentType ?? stat.contentType ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    // a file opened directly in a tab can never run script in the app's origin
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || start >= size) {
      return new Response("Range not satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    const stream = await store.createReadStream(key, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }
  const stream = await store.createReadStream(key);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: { ...headers, "Content-Length": String(size) },
  });
}
