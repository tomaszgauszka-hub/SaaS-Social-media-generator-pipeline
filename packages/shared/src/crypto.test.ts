import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, hashPassword, maskSecret, verifyPassword } from "./crypto.ts";

describe("password hashing", () => {
  it("verifies correct passwords and rejects wrong ones", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("secret encryption", () => {
  const key = randomBytes(32).toString("base64");

  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptSecret("EAAG-token", key);
    const b = encryptSecret("EAAG-token", key);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decryptSecret(a, key)).toBe("EAAG-token");
  });

  it("detects tampering", () => {
    const a = encryptSecret("secret", key);
    const tampered = { ...a, ciphertext: Buffer.from("xxxxxx").toString("base64") };
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it("requires a 32-byte key", () => {
    expect(() => encryptSecret("x", undefined)).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
    expect(() => encryptSecret("x", Buffer.from("short").toString("base64"))).toThrow(/32 bytes/);
  });

  it("masks secrets", () => {
    expect(maskSecret("sk-1234567890")).toBe("••••7890");
    expect(maskSecret(undefined)).toBe("—");
  });
});
