import { NextResponse, type NextRequest } from "next/server";
import { metaAuthorizeUrl, tiktokAuthorizeUrl } from "@cre/publishing";
import { getCurrentUser } from "@/lib/auth";
import { db, env } from "@/lib/db";
import { createOAuthState, OAUTH_COOKIE, redirectUri } from "@/lib/oauth";

/** Starts the official OAuth flow for Meta (Instagram + Facebook Page) or TikTok for one brand. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const user = await getCurrentUser();
  if (!user || (user.role !== "OWNER" && user.role !== "ADMIN"))
    return new Response("Forbidden", { status: 403 });
  const { provider } = await params;
  if (provider !== "meta" && provider !== "tiktok") return new Response("Unknown provider", { status: 404 });
  const brandId = request.nextUrl.searchParams.get("brandId") ?? "";
  const brand = await db().brand.findUnique({ where: { id: brandId }, select: { workspaceId: true } });
  if (!brand || brand.workspaceId !== user.workspaceId) return new Response("Unknown brand", { status: 404 });
  const e = env();
  const { state, cookie } = createOAuthState({ userId: user.userId, brandId, provider });
  let url: string;
  if (provider === "meta") {
    if (!e.META_APP_ID || !e.META_APP_SECRET)
      return NextResponse.redirect(new URL("/settings/providers?error=meta_not_configured", request.url));
    url = metaAuthorizeUrl({
      appId: e.META_APP_ID,
      redirectUri: redirectUri("meta"),
      state,
      graphVersion: e.META_GRAPH_API_VERSION,
    });
  } else {
    if (!e.TIKTOK_CLIENT_KEY || !e.TIKTOK_CLIENT_SECRET)
      return NextResponse.redirect(new URL("/settings/providers?error=tiktok_not_configured", request.url));
    url = tiktokAuthorizeUrl({ clientKey: e.TIKTOK_CLIENT_KEY, redirectUri: redirectUri("tiktok"), state });
  }
  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_COOKIE, cookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/oauth",
    maxAge: 600,
  });
  return res;
}
