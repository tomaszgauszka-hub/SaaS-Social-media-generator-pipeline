import { ProviderError } from "@cre/shared";

/** JSON request helper for social APIs: timeouts, status-aware retryability, no secrets in errors. */
export async function socialRequest<T>(
  provider: string,
  url: string,
  init: RequestInit & { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(init.timeoutMs ?? 60_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (err) {
    throw new ProviderError(provider, `network error: ${(err as Error).message}`, {
      cause: err,
      retryable: true,
    });
  }
  const text = await res.text();
  const body = parseBody(text);
  if (!res.ok) {
    const c = classifySocialError(res.status, body);
    throw new ProviderError(provider, c.message, {
      status: res.status,
      code: c.code,
      ...(c.retryable !== undefined ? { retryable: c.retryable } : {}),
    });
  }
  return body as T;
}

/** Meta Graph API error codes (developers.facebook.com/docs/graph-api/guides/error-handling). */
const META_AUTH_CODES = new Set([102, 190]); // invalid / expired session or token → reconnect the account
const META_THROTTLE_CODES = new Set([4, 17, 32, 341, 613]); // app / user / page rate limits → retry later
const META_TRANSIENT_CODES = new Set([1, 2]); // unknown / service temporarily unavailable

export interface SocialErrorClass {
  message: string;
  code: "AUTH_EXPIRED" | "PERMISSION_DENIED" | "RATE_LIMITED" | "PROVIDER_ERROR";
  /** undefined = decide from the HTTP status (5xx / 408 / 429 retryable) */
  retryable?: boolean;
}

/**
 * Classify a failed Meta / TikTok response. Meta reports throttling with HTTP 400 + error code 4/17/32/613, which
 * must be retried rather than dead-lettered; expired tokens and missing permissions need a human, not retries.
 */
export function classifySocialError(status: number, body: unknown): SocialErrorClass {
  const e = errorObject(body);
  const message = e.message ? `${e.message}${e.code !== undefined ? ` (${e.code})` : ""}` : `HTTP ${status}`;
  const numeric = typeof e.code === "number" ? e.code : null;
  if (
    status === 401 ||
    (numeric !== null && META_AUTH_CODES.has(numeric)) ||
    e.code === "access_token_invalid"
  )
    return { message, code: "AUTH_EXPIRED", retryable: false };
  if (
    (numeric !== null && (numeric === 10 || (numeric >= 200 && numeric < 300))) ||
    e.code === "scope_not_authorized"
  )
    return { message, code: "PERMISSION_DENIED", retryable: false };
  if (
    status === 429 ||
    (numeric !== null && META_THROTTLE_CODES.has(numeric)) ||
    e.code === "rate_limit_exceeded"
  )
    return { message, code: "RATE_LIMITED", retryable: true };
  if (e.isTransient || (numeric !== null && META_TRANSIENT_CODES.has(numeric)))
    return { message, code: "PROVIDER_ERROR", retryable: true };
  return { message, code: "PROVIDER_ERROR" };
}

/**
 * JSON.parse that keeps integers beyond 2^53 exact (as strings): TikTok returns post ids as int64 numbers, which
 * plain JSON.parse silently rounds to a different id. Uses the reviver's source-text access (Node ≥ 21).
 */
export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === "number" &&
    !Number.isSafeInteger(value) &&
    context?.source !== undefined &&
    /^-?\d+$/.test(context.source)
      ? context.source
      : value,
  );
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return parseJsonExact(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function errorObject(body: unknown): { message?: string; code?: string | number; isTransient?: boolean } {
  if (!body || typeof body !== "object") return {};
  const b = body as {
    error?: { message?: string; code?: string | number; is_transient?: boolean } | string;
    message?: string;
  };
  if (typeof b.error === "string") return { message: b.error };
  if (b.error && typeof b.error === "object") {
    return {
      ...(b.error.message ? { message: b.error.message } : {}),
      ...(b.error.code !== undefined ? { code: b.error.code } : {}),
      ...(b.error.is_transient ? { isTransient: true } : {}),
    };
  }
  return b.message ? { message: b.message } : {};
}

/** Strip tokens from URLs before logging. */
export function redactUrl(url: string): string {
  return url.replace(/(access_token|client_secret|code)=[^&]+/g, "$1=[redacted]");
}
