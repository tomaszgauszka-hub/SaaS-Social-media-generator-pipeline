import { vi } from "vitest";

/**
 * Minimal fetch stub for adapter tests: real provider adapters are exercised against scripted HTTP replies, never
 * the live APIs (no keys, no spend). Unmatched requests reject, so an unexpected call fails the test loudly.
 */
export interface CapturedRequest {
  method: string;
  url: URL;
  headers: Headers;
  /** request body as text (JSON string / form encoding) or null */
  body: string | null;
}

export type StubReply = Response | ((req: CapturedRequest) => Response | Promise<Response>);

interface Route {
  method: string;
  match: string | RegExp;
  replies: StubReply[];
  used: number;
}

export interface FetchStub {
  calls: CapturedRequest[];
  /**
   * Reply to METHOD + URL. A string must equal the URL without its query string (or the full URL); a RegExp is
   * tested against the full URL. Several replies are served in order; the last one repeats.
   */
  on(method: string, match: string | RegExp, ...replies: StubReply[]): FetchStub;
  /** calls whose URL without query string equals `url` */
  callsTo(url: string): CapturedRequest[];
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain", ...headers } });
}

function bodyText(body: RequestInit["body"]): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return "[stream]";
}

function bare(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/** Install the stub as globalThis.fetch (undo with vi.unstubAllGlobals()). */
export function stubFetch(): FetchStub {
  const routes: Route[] = [];
  const calls: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const req: CapturedRequest = {
      method: (init.method ?? "GET").toUpperCase(),
      url,
      headers: new Headers(init.headers),
      body: bodyText(init.body),
    };
    calls.push(req);
    const route = routes.find(
      (r) =>
        r.method === req.method &&
        (typeof r.match === "string"
          ? bare(url) === r.match || url.href === r.match
          : r.match.test(url.href)),
    );
    if (!route) throw new TypeError(`fetch stub: unexpected ${req.method} ${bare(url)}`);
    const reply = route.replies[Math.min(route.used, route.replies.length - 1)]!;
    route.used++;
    const res = typeof reply === "function" ? await reply(req) : reply;
    // a Response body can be read once; hand out a copy so repeated replies keep working
    return res.clone();
  });
  vi.stubGlobal("fetch", fetchMock);
  const stub: FetchStub = {
    calls,
    on(method, match, ...replies) {
      if (replies.length === 0) throw new Error("fetch stub: a route needs at least one reply");
      routes.push({ method: method.toUpperCase(), match, replies, used: 0 });
      return stub;
    },
    callsTo(target) {
      return calls.filter((c) => bare(c.url) === target);
    },
  };
  return stub;
}
