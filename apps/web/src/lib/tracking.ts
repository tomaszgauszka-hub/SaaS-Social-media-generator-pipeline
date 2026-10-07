import { randomBytes } from "node:crypto";
import { env } from "./db";

const g = globalThis as unknown as { __creEphemeralHashSecret?: string };

/**
 * Secret for daily-rotating visitor hashes. Without TRACKING_HASH_SECRET a per-process random secret is used:
 * unique-visitor counts then reset on restart, but nothing linkable is ever stored.
 */
export function trackingSecret(): string {
  const configured = env().TRACKING_HASH_SECRET;
  if (configured) return configured;
  g.__creEphemeralHashSecret ??= randomBytes(32).toString("hex");
  return g.__creEphemeralHashSecret;
}
