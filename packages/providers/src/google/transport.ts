import {
  FatalError,
  LogEvent,
  ProviderError,
  getLogger,
  sleep as abortableSleep,
  type Logger,
} from "@cre/shared";
import { safeUrl } from "../http.ts";
import type { RateLimiter } from "./rate-limit.ts";

/**
 * HTTP transport shared by every Google surface:
 *   - auth per surface: `x-goog-api-key` for generativelanguage.googleapis.com, `Authorization: Bearer` (+
 *     `x-goog-user-project`) for Cloud TTS / Speech-to-Text / Agent Platform. A missing credential raises a
 *     FatalError at CALL time (constructing the client never fails).
 *   - one process-wide rate limiter (GOOGLE_MAX_RPM) in front of every attempt.
 *   - retries 429 / 500 / 502 / 503 / 504 and connection failures with exponential backoff, honouring
 *     `Retry-After` and google.rpc.RetryInfo (max 3 attempts, abortable). Timeouts are NOT retried here (the
 *     request may have been billed) — they surface as retryable ProviderErrors for the job runner.
 *   - error mapping: HTTP 4xx → non-retryable ProviderError, 5xx / 429 → retryable, with Google's
 *     `error.status` / `error.message`. Keys and tokens are redacted from every message; bodies and headers are
 *     never logged.
 */

export const GOOGLE_PROVIDER = "google";
export const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
/** inline base64 media responses (images, songs, 8 s videos) stay far below this */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export type GoogleAuth = "api_key" | "cloud_token" | "none";

export interface TransportConfig {
  apiKey?: string | undefined;
  cloudToken?: string | undefined;
  /** quota / billing project for Cloud APIs (x-goog-user-project) */
  cloudProject?: string | undefined;
  rateLimiter: RateLimiter;
  logger?: Logger;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  /** a server asking to wait longer than this is not waited for (retryable error instead) */
  maxRetryDelayMs?: number;
}

export interface TransportRequest {
  method: "GET" | "POST";
  url: string;
  auth: GoogleAuth;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** log / error label, e.g. "generateContent reel.director" */
  label: string;
  model?: string;
  /** retry 429/5xx (default true) */
  retry?: boolean;
  /** "manual" lets the caller re-issue a redirect without credentials (downloads) */
  redirect?: RequestInit["redirect"];
  /** refuse larger response bodies (downloads); default 64 MB */
  maxResponseBytes?: number;
}

export interface TransportResponse {
  status: number;
  headers: Headers;
  body: Buffer;
  latencyMs: number;
  attempts: number;
}

/** The `{ error: { code, status, message, details } }` envelope of Google APIs. */
export interface GoogleErrorBody {
  code?: number;
  status?: string;
  message?: string;
  details?: { "@type"?: string; retryDelay?: string; reason?: string }[];
}

export class GoogleTransport {
  readonly logger: Logger;
  private readonly cfg: TransportConfig;

  constructor(cfg: TransportConfig) {
    this.cfg = cfg;
    this.logger = cfg.logger ?? getLogger().child({ provider: GOOGLE_PROVIDER });
  }

  get hasApiKey(): boolean {
    return Boolean(this.cfg.apiKey);
  }

  get hasCloudToken(): boolean {
    return Boolean(this.cfg.cloudToken);
  }

  get hasCloudProject(): boolean {
    return Boolean(this.cfg.cloudProject);
  }

  /** Replace every configured secret in `text` (Google never echoes keys, but proxies and SDK errors might). */
  redact(text: string): string {
    let out = text;
    for (const secret of [this.cfg.apiKey, this.cfg.cloudToken]) {
      if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
    }
    return out;
  }

  private authHeaders(auth: GoogleAuth, label: string): Record<string, string> {
    switch (auth) {
      case "api_key":
        if (!this.cfg.apiKey) throw new FatalError(`${label}: GOOGLE_API_KEY is not configured`);
        return { "x-goog-api-key": this.cfg.apiKey };
      case "cloud_token":
        if (!this.cfg.cloudToken)
          throw new FatalError(`${label}: GOOGLE_CLOUD_ACCESS_TOKEN is not configured`);
        return {
          Authorization: `Bearer ${this.cfg.cloudToken}`,
          ...(this.cfg.cloudProject ? { "x-goog-user-project": this.cfg.cloudProject } : {}),
        };
      case "none":
        return {};
    }
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    const headers: Record<string, string> = { ...this.authHeaders(req.auth, req.label) };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.body);
    }
    const maxAttempts = req.retry === false ? 1 : Math.max(1, this.cfg.maxAttempts ?? 3);
    const fetchImpl = this.cfg.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      req.signal?.throwIfAborted();
      await this.cfg.rateLimiter.acquire(req.signal);
      const timeout = AbortSignal.timeout(req.timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await fetchImpl(req.url, {
          method: req.method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal,
          ...(req.redirect ? { redirect: req.redirect } : {}),
        });
      } catch (err) {
        if (req.signal?.aborted) throw req.signal.reason instanceof Error ? req.signal.reason : err;
        if (timeout.aborted) {
          throw new ProviderError(GOOGLE_PROVIDER, `${req.label} timed out after ${req.timeoutMs} ms`, {
            code: "TIMEOUT",
            retryable: true,
            // the server may have done (and billed) the work
            charged: req.method === "POST",
          });
        }
        const message = this.redact(errText(err));
        if (attempt < maxAttempts) {
          await this.backoff(req, attempt, this.backoffMs(attempt), `network error: ${message}`);
          continue;
        }
        throw new ProviderError(GOOGLE_PROVIDER, `${req.label}: network error calling ${safeUrl(req.url)}`, {
          cause: err,
          retryable: true,
          details: { message },
        });
      }
      const maxBytes = req.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError(
          GOOGLE_PROVIDER,
          `${req.label}: response of ${declared} bytes exceeds ${maxBytes}`,
          {
            retryable: false,
            charged: req.method === "POST",
          },
        );
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) {
        throw new ProviderError(
          GOOGLE_PROVIDER,
          `${req.label}: response of ${buf.length} bytes exceeds ${maxBytes}`,
          {
            retryable: false,
            charged: req.method === "POST",
          },
        );
      }
      if (res.ok || (req.redirect === "manual" && res.status >= 300 && res.status < 400)) {
        const latencyMs = Date.now() - started;
        this.logger.debug(
          { label: req.label, model: req.model, status: res.status, attempts: attempt, latencyMs },
          "google request ok",
        );
        return { status: res.status, headers: res.headers, body: buf, latencyMs, attempts: attempt };
      }
      const gErr = parseGoogleError(buf);
      if (RETRY_STATUSES.has(res.status) && attempt < maxAttempts) {
        const wait =
          retryDelayMs(res.headers.get("retry-after"), gErr, Date.now()) ?? this.backoffMs(attempt);
        if (wait <= (this.cfg.maxRetryDelayMs ?? 60_000)) {
          await this.backoff(req, attempt, wait, `HTTP ${res.status} ${gErr?.status ?? ""}`.trim());
          continue;
        }
        this.logger.warn(
          { label: req.label, model: req.model, status: res.status, retryAfterMs: wait },
          "google asked to wait longer than the retry cap — giving up for now",
        );
      }
      throw this.httpError(req, res.status, gErr, buf);
    }
  }

  async requestJson<T>(req: TransportRequest): Promise<{ data: T; latencyMs: number; attempts: number }> {
    const res = await this.request(req);
    try {
      return {
        data: JSON.parse(res.body.toString("utf8")) as T,
        latencyMs: res.latencyMs,
        attempts: res.attempts,
      };
    } catch (err) {
      throw new ProviderError(GOOGLE_PROVIDER, `${req.label}: invalid JSON from ${safeUrl(req.url)}`, {
        cause: err,
        retryable: true,
        charged: req.method === "POST",
      });
    }
  }

  private backoffMs(attempt: number): number {
    const base = this.cfg.baseBackoffMs ?? 1_000;
    const exp = base * 2 ** (attempt - 1);
    // equal jitter: half fixed, half random → never 0, never synchronised across workers
    return Math.round(exp / 2 + ((this.cfg.random ?? Math.random)() * exp) / 2);
  }

  private async backoff(req: TransportRequest, attempt: number, waitMs: number, why: string): Promise<void> {
    this.logger.warn(
      { event: LogEvent.RETRY, label: req.label, model: req.model, attempt, waitMs, reason: why },
      "google request retry",
    );
    await (this.cfg.sleep ?? abortableSleep)(waitMs, req.signal);
  }

  private httpError(req: TransportRequest, status: number, gErr: GoogleErrorBody | undefined, raw: Buffer) {
    const detail = this.redact((gErr?.message ?? raw.toString("utf8")).slice(0, 400));
    const code =
      status === 401 || status === 403
        ? "AUTH"
        : status === 429
          ? "RATE_LIMITED"
          : status === 404
            ? "NOT_FOUND"
            : "PROVIDER_ERROR";
    this.logger.warn(
      { label: req.label, model: req.model, status, googleStatus: gErr?.status },
      "google request failed",
    );
    return new ProviderError(
      GOOGLE_PROVIDER,
      `${req.label}: HTTP ${status}${gErr?.status ? ` ${gErr.status}` : ""} from ${safeUrl(req.url)}: ${detail}`,
      { status, code, details: { googleStatus: gErr?.status, model: req.model } },
    );
  }
}

export function parseGoogleError(body: Buffer | string): GoogleErrorBody | undefined {
  try {
    const parsed = JSON.parse(typeof body === "string" ? body : body.toString("utf8")) as unknown;
    const first = Array.isArray(parsed) ? (parsed[0] as unknown) : parsed;
    const err = (first as { error?: GoogleErrorBody } | undefined)?.error;
    return err && typeof err === "object" ? err : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Server-requested delay: `Retry-After` (seconds or HTTP date) wins, then google.rpc.RetryInfo.retryDelay
 * ("23s") from the error body. undefined → use exponential backoff.
 */
export function retryDelayMs(
  retryAfter: string | null,
  gErr: GoogleErrorBody | undefined,
  nowMs: number,
): number | undefined {
  if (retryAfter) {
    const secs = Number(retryAfter.trim());
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  }
  const info = gErr?.details?.find((d) => d["@type"]?.endsWith("google.rpc.RetryInfo"));
  const m = info?.retryDelay ? /^(\d+(?:\.\d+)?)s$/.exec(info.retryDelay) : null;
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}
