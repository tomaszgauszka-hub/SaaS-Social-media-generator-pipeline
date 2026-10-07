import type { CredentialKind, DbClient, Prisma, ProviderCredential } from "@cre/db";
import { decryptSecret, encryptSecret, FatalError, toJson } from "@cre/shared";

/**
 * Encrypted credential storage (AES-256-GCM, key from CREDENTIALS_ENCRYPTION_KEY). Secrets are decrypted
 * only inside server code paths that need them (publishing, analytics, provider calls) and are never
 * returned to the browser — the settings UI only sees masked values and metadata.
 */
export interface OAuthSecret {
  accessToken: string;
  refreshToken?: string | null;
  /** Facebook page access token */
  pageAccessToken?: string | null;
  refreshExpiresAt?: string | null;
}

export interface SaveCredentialInput {
  id?: string;
  workspaceId: string;
  provider: string;
  kind: CredentialKind;
  label: string;
  secret: string | OAuthSecret;
  scopes?: string[];
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
  keyB64: string | undefined;
  keyVersion?: number;
}

export async function saveCredential(db: DbClient, input: SaveCredentialInput): Promise<ProviderCredential> {
  const plaintext = typeof input.secret === "string" ? input.secret : JSON.stringify(input.secret);
  const enc = encryptSecret(plaintext, input.keyB64, input.keyVersion ?? 1);
  const data = {
    provider: input.provider,
    kind: input.kind,
    label: input.label,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    authTag: enc.authTag,
    keyVersion: enc.keyVersion,
    scopes: input.scopes ?? [],
    expiresAt: input.expiresAt ?? null,
    status: "ACTIVE" as const,
    lastError: null,
    ...(input.metadata ? { metadata: toJson(input.metadata) as Prisma.InputJsonValue } : {}),
  };
  if (input.id) return db.providerCredential.update({ where: { id: input.id }, data });
  return db.providerCredential.create({ data: { workspaceId: input.workspaceId, ...data } });
}

/** Decrypt a stored credential. Throws when it is missing, revoked or undecryptable. */
export async function readCredentialSecret(
  db: DbClient,
  credentialId: string,
  keyB64: string | undefined,
): Promise<{ credential: ProviderCredential; secret: string }> {
  const credential = await db.providerCredential.findUnique({ where: { id: credentialId } });
  if (!credential) throw new FatalError(`Credential ${credentialId} not found`);
  if (credential.status !== "ACTIVE")
    throw new FatalError(`Credential "${credential.label}" is ${credential.status} — reconnect the account`);
  try {
    return { credential, secret: decryptSecret(credential, keyB64) };
  } catch (err) {
    throw new FatalError(
      `Credential "${credential.label}" cannot be decrypted (wrong CREDENTIALS_ENCRYPTION_KEY?)`,
      { cause: err },
    );
  }
}

export function parseOAuthSecret(secret: string): OAuthSecret {
  try {
    const parsed = JSON.parse(secret) as Partial<OAuthSecret>;
    if (typeof parsed.accessToken === "string" && parsed.accessToken) return parsed as OAuthSecret;
  } catch {
    // a bare token string
  }
  return { accessToken: secret };
}

export async function markCredentialError(
  db: DbClient,
  credentialId: string,
  message: string,
  status: "ERROR" | "EXPIRED" | "REVOKED" = "ERROR",
): Promise<void> {
  await db.providerCredential.update({
    where: { id: credentialId },
    data: { status, lastError: message.slice(0, 500) },
  });
}
