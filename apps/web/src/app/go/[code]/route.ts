import type { NextRequest } from "next/server";
import { buildRedirectUrl, recordClick } from "@cre/core";
import { errorMessage } from "@cre/shared";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { cdnCountry, clientIp } from "@/lib/request";
import { trackingSecret } from "@/lib/tracking";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
/** recorded clicks per visitor IP and link per minute (generous: carrier NAT puts many people on one IP) */
const CLICKS_PER_MINUTE = 30;

async function findLink(code: string) {
  if (!/^[A-Za-z0-9]{4,24}$/.test(code)) return null;
  const link = await db().trackedLink.findUnique({ where: { code } });
  if (!link || !link.isActive || (link.expiresAt && link.expiresAt.getTime() < Date.now())) return null;
  return link;
}

function notFound() {
  return new Response("This link is no longer active.", {
    status: 404,
    headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * Tracking redirect /go/<code>: records one privacy-minimised click (no raw IP / user agent stored; bots flagged)
 * and redirects to the destination with our click id as the network sub-id for revenue attribution.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const link = await findLink(code);
  if (!link) return notFound();
  const ip = clientIp(request.headers);
  // click floods (scripts, refresh loops) still get redirected, but stop inflating clicks and DB writes
  if (ip && !rateLimit(`go:${ip}:${link.id}`, CLICKS_PER_MINUTE, 60_000).ok)
    return new Response(null, {
      status: 302,
      headers: { ...HEADERS, Location: buildRedirectUrl(link, "untracked") },
    });
  let location: string;
  try {
    const click = await recordClick(db(), link, {
      ip,
      userAgent: request.headers.get("user-agent"),
      referer: request.headers.get("referer"),
      country: cdnCountry(request.headers),
      query: request.nextUrl.searchParams,
      hashSecret: trackingSecret(),
    });
    location = click.redirectUrl;
  } catch (err) {
    // never strand a visitor because analytics failed
    console.error("click recording failed", errorMessage(err));
    location = buildRedirectUrl(link, "untracked");
  }
  return new Response(null, { status: 302, headers: { ...HEADERS, Location: location } });
}

/** Link previews / uptime checks: redirect without counting a click. */
export async function HEAD(_request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const link = await findLink((await params).code);
  if (!link) return new Response(null, { status: 404, headers: HEADERS });
  return new Response(null, { status: 302, headers: { ...HEADERS, Location: link.destinationUrl } });
}
