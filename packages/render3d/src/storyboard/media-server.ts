import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

/*
 * Loopback-only file server for the Remotion render: the renderer loads 3D clips by http URL instead of
 * re-bundling a public dir per reel. Serves only the files it was given (no directory listing, no path from the
 * request ever reaches the file system) and supports Range requests (video seeking).
 */

export interface MediaServer {
  baseUrl: string;
  url(name: string): string;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

export async function serveMedia(files: Record<string, string>): Promise<MediaServer> {
  const table = new Map<string, string>();
  for (const [name, file] of Object.entries(files)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(name)) throw new Error(`invalid media name ${name}`);
    table.set(`/${name}`, path.resolve(file));
  }
  const server = http.createServer((req, res) => {
    const file = req.url ? table.get(req.url.split("?")[0]!) : undefined;
    if (!file || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404).end();
      return;
    }
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      res.writeHead(404).end();
      return;
    }
    const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
      });
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    url: (name) => `${baseUrl}/${name}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
