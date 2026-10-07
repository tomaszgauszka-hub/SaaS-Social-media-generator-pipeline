/** Client IP as seen by the first trusted proxy (never stored raw — only hashed for unique-visitor counts). */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || null;
  return headers.get("x-real-ip");
}

/** Country from a trusted CDN header, if present. */
export function cdnCountry(headers: Headers): string | null {
  return (
    headers.get("cf-ipcountry") ??
    headers.get("x-vercel-ip-country") ??
    headers.get("cloudfront-viewer-country")
  );
}
