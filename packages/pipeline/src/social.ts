import { parseOAuthSecret, readCredentialSecret, saveCredential } from "@cre/core";
import type { SocialAccount } from "@cre/db";
import {
  isSocialPlatform,
  tiktokRefresh,
  type SocialAccountRef,
  type SocialCredentials,
  type SocialPublisher,
} from "@cre/publishing";
import { AppError, FatalError } from "@cre/shared";
import type { PipelineContext } from "./context.ts";

/**
 * Publisher selection with two safety layers:
 *  1. accounts flagged isMock (and MOCK_SOCIAL=true) always use the mock publisher — nothing leaves the machine;
 *  2. real publishers additionally require the PUBLISHING_ENABLED kill switch.
 */
export function publisherFor(
  ctx: PipelineContext,
  account: Pick<SocialAccount, "platform" | "isMock" | "handle">,
): SocialPublisher {
  if (!isSocialPlatform(account.platform)) throw new FatalError(`Unsupported platform ${account.platform}`);
  if (account.isMock) return ctx.mockPublisher;
  const publisher = ctx.publishers[account.platform];
  if (!publisher.isMock && !ctx.env.PUBLISHING_ENABLED) {
    throw new FatalError(
      `Refusing to publish to ${account.platform} ${account.handle}: PUBLISHING_ENABLED=false (kill switch). Enable it only when you intend to post publicly.`,
      { code: "PUBLISHING_DISABLED" },
    );
  }
  return publisher;
}

export function accountRef(account: SocialAccount): SocialAccountRef {
  if (!isSocialPlatform(account.platform)) throw new FatalError(`Unsupported platform ${account.platform}`);
  return {
    id: account.id,
    platform: account.platform,
    handle: account.handle,
    externalAccountId: account.externalAccountId,
    isMock: account.isMock,
    metadata: (account.metadata ?? null) as Record<string, unknown> | null,
  };
}

/** Decrypted tokens for a real account (server-side only, never logged). Mock accounts have none. */
export async function loadSocialCredentials(
  ctx: PipelineContext,
  account: SocialAccount,
  publisher: SocialPublisher,
): Promise<SocialCredentials | null> {
  if (publisher.isMock) return null;
  if (account.status === "NEEDS_REAUTH")
    throw new FatalError(
      `${account.platform} account ${account.handle} was rejected by the platform — reconnect it under Brands`,
      { code: "NEEDS_REAUTH" },
    );
  if (!account.credentialId)
    throw new FatalError(
      `${account.platform} account ${account.handle} is not connected (no OAuth credential)`,
    );
  const { credential, secret } = await readCredentialSecret(
    ctx.prisma,
    account.credentialId,
    ctx.env.CREDENTIALS_ENCRYPTION_KEY,
  );
  let token = parseOAuthSecret(secret);
  let expiresAt = credential.expiresAt;
  const soon = ctx.clock.now().getTime() + 10 * 60_000;
  // TikTok access tokens live ~24 h: refresh with the stored refresh token before they lapse
  if (
    account.platform === "TIKTOK" &&
    expiresAt &&
    expiresAt.getTime() < soon &&
    token.refreshToken &&
    ctx.env.TIKTOK_CLIENT_KEY &&
    ctx.env.TIKTOK_CLIENT_SECRET
  ) {
    const fresh = await tiktokRefresh({
      clientKey: ctx.env.TIKTOK_CLIENT_KEY,
      clientSecret: ctx.env.TIKTOK_CLIENT_SECRET,
      refreshToken: token.refreshToken,
    });
    token = {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken,
      refreshExpiresAt: fresh.refreshExpiresAt.toISOString(),
    };
    expiresAt = fresh.expiresAt;
    await saveCredential(ctx.prisma, {
      id: credential.id,
      workspaceId: credential.workspaceId,
      provider: credential.provider,
      kind: credential.kind,
      label: credential.label,
      secret: token,
      scopes: fresh.scope.split(","),
      expiresAt,
      keyB64: ctx.env.CREDENTIALS_ENCRYPTION_KEY,
    });
  }
  if (expiresAt && expiresAt.getTime() < ctx.clock.now().getTime()) {
    throw new FatalError(`Access token for ${account.handle} expired — reconnect the account`, {
      code: "TOKEN_EXPIRED",
    });
  }
  return {
    accessToken: token.accessToken,
    ...(token.pageAccessToken ? { pageAccessToken: token.pageAccessToken } : {}),
    expiresAt,
  };
}

/** Error codes meaning the stored OAuth grant no longer works — retries cannot fix them, a reconnect can. */
const REAUTH_CODES = new Set(["AUTH_EXPIRED", "TOKEN_EXPIRED", "PERMISSION_DENIED"]);

export function needsReauth(err: unknown): boolean {
  return err instanceof AppError && REAUTH_CODES.has(err.code);
}

/**
 * Flag a real account whose token was rejected so the dashboard asks for a reconnect (the OAuth callback sets it
 * back to CONNECTED). Mock accounts are never touched.
 */
export async function flagReauthIfNeeded(
  ctx: PipelineContext,
  account: Pick<SocialAccount, "id" | "isMock" | "handle" | "platform">,
  err: unknown,
): Promise<boolean> {
  if (account.isMock || !needsReauth(err)) return false;
  const { count } = await ctx.prisma.socialAccount.updateMany({
    where: { id: account.id, status: "CONNECTED" },
    data: { status: "NEEDS_REAUTH" },
  });
  if (count > 0)
    ctx.logger.warn(
      { socialAccountId: account.id, platform: account.platform, code: (err as AppError).code },
      "social account needs to be reconnected",
    );
  return count > 0;
}
