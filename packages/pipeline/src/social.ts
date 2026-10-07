import { parseOAuthSecret, readCredentialSecret } from "@cre/core";
import type { SocialAccount } from "@cre/db";
import {
  isSocialPlatform,
  type SocialAccountRef,
  type SocialCredentials,
  type SocialPublisher,
} from "@cre/publishing";
import { FatalError } from "@cre/shared";
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
  if (!account.credentialId)
    throw new FatalError(
      `${account.platform} account ${account.handle} is not connected (no OAuth credential)`,
    );
  const { credential, secret } = await readCredentialSecret(
    ctx.prisma,
    account.credentialId,
    ctx.env.CREDENTIALS_ENCRYPTION_KEY,
  );
  const token = parseOAuthSecret(secret);
  if (credential.expiresAt && credential.expiresAt.getTime() < ctx.clock.now().getTime()) {
    throw new FatalError(`Access token for ${account.handle} expired — reconnect the account`, {
      code: "TOKEN_EXPIRED",
    });
  }
  return {
    accessToken: token.accessToken,
    ...(token.pageAccessToken ? { pageAccessToken: token.pageAccessToken } : {}),
    expiresAt: credential.expiresAt,
  };
}
