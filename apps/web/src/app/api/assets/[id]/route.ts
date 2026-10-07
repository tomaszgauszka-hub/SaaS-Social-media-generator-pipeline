import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";

/**
 * Authenticated media streaming for the dashboard (videos, covers, images) with HTTP Range support
 * (required by Safari/iOS for <video>). Remote storage redirects to a short-lived signed URL.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const asset = await db().asset.findUnique({
    where: { id },
    select: { workspaceId: true, status: true, storageKey: true, mimeType: true, sizeBytes: true },
  });
  if (!asset || asset.workspaceId !== user.workspaceId || asset.status !== "READY" || !asset.storageKey) {
    return new Response("Not found", { status: 404 });
  }
  const store = storage();
  if (store.driver === "s3") {
    const url = await store.getSignedUrl(asset.storageKey, 300);
    if (url) return Response.redirect(url, 302);
  }
  const stat = await store.stat(asset.storageKey);
  if (!stat) return new Response("Not found", { status: 404 });
  const size = stat.sizeBytes;
  const type = asset.mimeType ?? stat.contentType ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  };
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
    const stream = await store.createReadStream(asset.storageKey, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }
  const stream = await store.createReadStream(asset.storageKey);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: { ...headers, "Content-Length": String(size) },
  });
}
