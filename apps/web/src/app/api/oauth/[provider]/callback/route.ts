import { NextResponse, type NextRequest } from "next/server";
import { saveCredential } from "@cre/core";
import type { Platform, TxClient } from "@cre/db";
import { metaExchangeCode, tiktokExchangeCode } from "@cre/publishing";
import { errorMessage } from "@cre/shared";
import { getCurrentUser } from "@/lib/auth";
import { db, env } from "@/lib/db";
import { OAUTH_COOKIE, readOAuthState, redirectUri } from "@/lib/oauth";

async function upsertAccount(
  tx: TxClient,
  input: {
    workspaceId: string;
    brandId: string;
    platform: Platform;
    handle: string;
    displayName: string;
    externalAccountId: string;
    credentialId: string;
    metadata: Record<string, string | null>;
  },
) {
  const existing = await tx.socialAccount.findFirst({
    where: { brandId: input.brandId, platform: input.platform, externalAccountId: input.externalAccountId },
  });
  const data = {
    handle: input.handle,
    displayName: input.displayName,
    credentialId: input.credentialId,
    status: "CONNECTED" as const,
    isMock: false,
    metadata: input.metadata,
  };
  const account = existing
    ? await tx.socialAccount.update({ where: { id: existing.id }, data })
    : await tx.socialAccount.create({
        data: {
          ...data,
          workspaceId: input.workspaceId,
          brandId: input.brandId,
          platform: input.platform,
          externalAccountId: input.externalAccountId,
        },
      });
  // the real account replaces the mock one for scheduling; mock accounts are kept for history but disconnected
  await tx.socialAccount.updateMany({
    where: { brandId: input.brandId, platform: input.platform, isMock: true },
    data: { status: "DISCONNECTED" },
  });
  await tx.publishingSlot.updateMany({
    where: { brandId: input.brandId, platform: input.platform },
    data: { socialAccountId: account.id },
  });
}

/** OAuth callback: verify state, exchange the code server-side, store tokens encrypted, connect the accounts. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const done = (query: string) => {
    const res = NextResponse.redirect(new URL(`/settings/providers?${query}`, request.url));
    res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/oauth" });
    return res;
  };
  const user = await getCurrentUser();
  const state = readOAuthState(
    request.cookies.get(OAUTH_COOKIE)?.value,
    request.nextUrl.searchParams.get("state"),
  );
  if (!user || !state || state.userId !== user.userId || state.provider !== provider)
    return done("error=invalid_oauth_state");
  const code = request.nextUrl.searchParams.get("code");
  if (!code)
    return done(`error=${encodeURIComponent(request.nextUrl.searchParams.get("error") ?? "access_denied")}`);
  const brand = await db().brand.findUnique({
    where: { id: state.brandId },
    select: { id: true, workspaceId: true, name: true },
  });
  if (!brand || brand.workspaceId !== user.workspaceId) return done("error=unknown_brand");
  const e = env();
  try {
    if (provider === "meta") {
      if (!e.META_APP_ID || !e.META_APP_SECRET) return done("error=meta_not_configured");
      const result = await metaExchangeCode({
        appId: e.META_APP_ID,
        appSecret: e.META_APP_SECRET,
        redirectUri: redirectUri("meta"),
        code,
        graphVersion: e.META_GRAPH_API_VERSION,
      });
      // one Facebook Page per brand: prefer the page with a linked Instagram professional account
      const page = result.pages.find((p) => p.instagramUserId) ?? result.pages[0];
      if (!page) return done("error=no_facebook_page");
      await db().$transaction(async (tx) => {
        const credential = await saveCredential(tx, {
          workspaceId: user.workspaceId,
          provider: "meta",
          kind: "OAUTH_TOKEN",
          label: `Meta · ${page.pageName} (${brand.name})`,
          secret: { accessToken: result.userAccessToken, pageAccessToken: page.pageAccessToken },
          expiresAt: result.expiresAt,
          metadata: { pageId: page.pageId, pageName: page.pageName, instagramUserId: page.instagramUserId },
          keyB64: e.CREDENTIALS_ENCRYPTION_KEY,
        });
        await upsertAccount(tx, {
          workspaceId: user.workspaceId,
          brandId: brand.id,
          platform: "FACEBOOK",
          handle: page.pageName,
          displayName: page.pageName,
          externalAccountId: page.pageId,
          credentialId: credential.id,
          metadata: { pageId: page.pageId },
        });
        if (page.instagramUserId) {
          await upsertAccount(tx, {
            workspaceId: user.workspaceId,
            brandId: brand.id,
            platform: "INSTAGRAM",
            handle: `@${page.instagramUsername ?? page.instagramUserId}`,
            displayName: page.instagramUsername ?? page.pageName,
            externalAccountId: page.instagramUserId,
            credentialId: credential.id,
            metadata: { pageId: page.pageId },
          });
        }
      });
      return done(`connected=meta${page.instagramUserId ? "" : "&warning=no_instagram_account"}`);
    }
    if (provider === "tiktok") {
      if (!e.TIKTOK_CLIENT_KEY || !e.TIKTOK_CLIENT_SECRET) return done("error=tiktok_not_configured");
      const tokens = await tiktokExchangeCode({
        clientKey: e.TIKTOK_CLIENT_KEY,
        clientSecret: e.TIKTOK_CLIENT_SECRET,
        code,
        redirectUri: redirectUri("tiktok"),
      });
      await db().$transaction(async (tx) => {
        const credential = await saveCredential(tx, {
          workspaceId: user.workspaceId,
          provider: "tiktok",
          kind: "OAUTH_TOKEN",
          label: `TikTok · ${brand.name}`,
          secret: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            refreshExpiresAt: tokens.refreshExpiresAt.toISOString(),
          },
          scopes: tokens.scope.split(","),
          expiresAt: tokens.expiresAt,
          metadata: { openId: tokens.openId },
          keyB64: e.CREDENTIALS_ENCRYPTION_KEY,
        });
        await upsertAccount(tx, {
          workspaceId: user.workspaceId,
          brandId: brand.id,
          platform: "TIKTOK",
          handle: `tiktok:${tokens.openId.slice(0, 8)}`,
          displayName: `${brand.name} TikTok`,
          externalAccountId: tokens.openId,
          credentialId: credential.id,
          metadata: { openId: tokens.openId },
        });
      });
      return done("connected=tiktok");
    }
    return done("error=unknown_provider");
  } catch (err) {
    console.error("oauth callback failed", errorMessage(err));
    return done("error=oauth_exchange_failed");
  }
}
