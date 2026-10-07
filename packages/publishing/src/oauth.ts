import { socialRequest } from "./http.ts";

/**
 * OAuth helpers (server-side only). Tokens are returned to the caller, which encrypts them into
 * ProviderCredential rows immediately; they are never sent to the browser.
 */

export const META_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_insights",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "business_management",
];

export function metaAuthorizeUrl(opts: {
  appId: string;
  redirectUri: string;
  state: string;
  graphVersion: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.appId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    response_type: "code",
    scope: META_SCOPES.join(","),
  });
  return `https://www.facebook.com/${opts.graphVersion}/dialog/oauth?${params.toString()}`;
}

export interface MetaPageAccount {
  pageId: string;
  pageName: string;
  pageAccessToken: string;
  instagramUserId: string | null;
  instagramUsername: string | null;
}

/** code → short-lived token → long-lived user token (~60 days) → pages + linked IG accounts. */
export async function metaExchangeCode(opts: {
  appId: string;
  appSecret: string;
  redirectUri: string;
  code: string;
  graphVersion: string;
}): Promise<{ userAccessToken: string; expiresAt: Date | null; pages: MetaPageAccount[] }> {
  const base = `https://graph.facebook.com/${opts.graphVersion}`;
  const short = await socialRequest<{ access_token: string }>(
    "meta",
    `${base}/oauth/access_token?${new URLSearchParams({
      client_id: opts.appId,
      client_secret: opts.appSecret,
      redirect_uri: opts.redirectUri,
      code: opts.code,
    }).toString()}`,
  );
  const long = await socialRequest<{ access_token: string; expires_in?: number }>(
    "meta",
    `${base}/oauth/access_token?${new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: opts.appId,
      client_secret: opts.appSecret,
      fb_exchange_token: short.access_token,
    }).toString()}`,
  );
  const accounts = await socialRequest<{
    data?: {
      id: string;
      name: string;
      access_token: string;
      instagram_business_account?: { id: string; username?: string };
    }[];
  }>(
    "meta",
    `${base}/me/accounts?${new URLSearchParams({
      fields: "id,name,access_token,instagram_business_account{id,username}",
      access_token: long.access_token,
    }).toString()}`,
  );
  return {
    userAccessToken: long.access_token,
    expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null,
    pages: (accounts.data ?? []).map((p) => ({
      pageId: p.id,
      pageName: p.name,
      pageAccessToken: p.access_token,
      instagramUserId: p.instagram_business_account?.id ?? null,
      instagramUsername: p.instagram_business_account?.username ?? null,
    })),
  };
}

export const TIKTOK_SCOPES = ["user.info.basic", "video.publish", "video.upload", "video.list"];

export function tiktokAuthorizeUrl(opts: { clientKey: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_key: opts.clientKey,
    scope: TIKTOK_SCOPES.join(","),
    response_type: "code",
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
}

export interface TikTokTokens {
  accessToken: string;
  refreshToken: string;
  openId: string;
  expiresAt: Date;
  refreshExpiresAt: Date;
  scope: string;
}

async function tiktokToken(body: Record<string, string>): Promise<TikTokTokens> {
  const res = await socialRequest<{
    access_token: string;
    refresh_token: string;
    open_id: string;
    expires_in: number;
    refresh_expires_in: number;
    scope: string;
  }>("tiktok", "https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    openId: res.open_id,
    expiresAt: new Date(Date.now() + res.expires_in * 1000),
    refreshExpiresAt: new Date(Date.now() + res.refresh_expires_in * 1000),
    scope: res.scope,
  };
}

export function tiktokExchangeCode(opts: {
  clientKey: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<TikTokTokens> {
  return tiktokToken({
    client_key: opts.clientKey,
    client_secret: opts.clientSecret,
    code: opts.code,
    grant_type: "authorization_code",
    redirect_uri: opts.redirectUri,
  });
}

export function tiktokRefresh(opts: {
  clientKey: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<TikTokTokens> {
  return tiktokToken({
    client_key: opts.clientKey,
    client_secret: opts.clientSecret,
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
  });
}
