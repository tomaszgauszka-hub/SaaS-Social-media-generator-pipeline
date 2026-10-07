import { randomBytes } from "node:crypto";
import { hmacSha256Hex, safeEqual } from "@cre/shared";
import { env } from "./db";

/**
 * OAuth CSRF protection: a random state bound to (user, brand, provider), HMAC-signed and kept in a short-lived
 * httpOnly cookie; the callback must present the same state.
 */
export const OAUTH_COOKIE = "cre_oauth";

function secret(): string {
  const e = env();
  const s = e.TRACKING_HASH_SECRET ?? e.CREDENTIALS_ENCRYPTION_KEY;
  if (!s) throw new Error("Set TRACKING_HASH_SECRET or CREDENTIALS_ENCRYPTION_KEY to use OAuth connections");
  return s;
}

export interface OAuthState {
  nonce: string;
  userId: string;
  brandId: string;
  provider: "meta" | "tiktok";
}

export function createOAuthState(input: Omit<OAuthState, "nonce">): { state: string; cookie: string } {
  const nonce = randomBytes(18).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ ...input, nonce })).toString("base64url");
  const sig = hmacSha256Hex(secret(), payload);
  return { state: nonce, cookie: `${payload}.${sig}` };
}

export function readOAuthState(cookie: string | undefined, state: string | null): OAuthState | null {
  if (!cookie || !state) return null;
  const [payload, sig] = cookie.split(".");
  if (!payload || !sig || !safeEqual(sig, hmacSha256Hex(secret(), payload))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    return safeEqual(parsed.nonce, state) ? parsed : null;
  } catch {
    return null;
  }
}

export function redirectUri(provider: "meta" | "tiktok"): string {
  return `${env().APP_URL.replace(/\/$/, "")}/api/oauth/${provider}/callback`;
}
