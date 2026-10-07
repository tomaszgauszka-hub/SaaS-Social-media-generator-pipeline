import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";

/* -------------------------------------------------------------------------------------------------
 * Password hashing (scrypt, node:crypto — no native dependencies)
 * Format: scrypt$N$r$p$<salt b64>$<key b64>
 * ----------------------------------------------------------------------------------------------- */

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function scrypt(password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number }) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCb(password, salt, keylen, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/* -------------------------------------------------------------------------------------------------
 * Secret encryption at rest (AES-256-GCM) for provider credentials / OAuth tokens.
 * The key is 32 random bytes, base64 encoded (CREDENTIALS_ENCRYPTION_KEY). keyVersion supports rotation.
 * ----------------------------------------------------------------------------------------------- */

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

function decodeKey(keyB64: string | undefined): Buffer {
  if (!keyB64) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY is not set — cannot encrypt/decrypt credentials");
  }
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("CREDENTIALS_ENCRYPTION_KEY must be 32 bytes (base64 encoded)");
  return key;
}

export function encryptSecret(
  plaintext: string,
  keyB64: string | undefined,
  keyVersion = 1,
): EncryptedSecret {
  const key = decodeKey(keyB64);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion,
  };
}

export function decryptSecret(
  secret: Omit<EncryptedSecret, "keyVersion">,
  keyB64: string | undefined,
): string {
  const key = decodeKey(keyB64);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(secret.iv, "base64"));
  decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Show only the last 4 characters of a secret (settings UI). */
export function maskSecret(value: string | undefined | null): string {
  if (!value) return "—";
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}
