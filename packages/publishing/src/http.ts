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
    const message = extractErrorMessage(body) ?? `HTTP ${res.status}`;
    // OAuth problems (190 = expired token on Meta) need re-authentication, not retries.
    const authError = res.status === 401 || /OAuth|access token|190/i.test(message);
    throw new ProviderError(provider, message, {
      status: res.status,
      retryable: authError ? false : undefined,
      code: authError ? "AUTH_EXPIRED" : "PROVIDER_ERROR",
    });
  }
  return body as T;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { error?: { message?: string; code?: string | number } | string; message?: string };
  if (typeof b.error === "string") return b.error;
  if (b.error?.message) return `${b.error.message}${b.error.code ? ` (${b.error.code})` : ""}`;
  return b.message ?? null;
}

/** Strip tokens from URLs before logging. */
export function redactUrl(url: string): string {
  return url.replace(/(access_token|client_secret|code)=[^&]+/g, "$1=[redacted]");
}
