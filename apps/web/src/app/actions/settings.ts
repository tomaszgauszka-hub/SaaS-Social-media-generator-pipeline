"use server";

import { revalidatePath } from "next/cache";
import { createLlmProvider } from "@cre/ai";
import { checkMediaProviders, createMediaProviders } from "@cre/providers";
import { errorMessage, NotFoundError } from "@cre/shared";
import { requireActor } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/action-result";
import { db, env } from "@/lib/db";

/** Health checks only (no generation calls): e.g. DeepSeek /user/balance, storage write/read. */
export async function testProvidersAction(): Promise<ActionResult> {
  try {
    await requireActor("admin");
    const e = env();
    const parts: string[] = [];
    try {
      const llm = createLlmProvider(e);
      const h = await llm.healthCheck();
      parts.push(`LLM ${llm.name}: ${h.ok ? "ok" : "FAILED"}${h.message ? ` (${h.message})` : ""}`);
    } catch (err) {
      parts.push(`LLM: ${errorMessage(err)}`);
    }
    try {
      for (const h of await checkMediaProviders(createMediaProviders(e)))
        parts.push(`${h.provider}: ${h.ok ? "ok" : "FAILED"}${h.message ? ` (${h.message})` : ""}`);
    } catch (err) {
      parts.push(`media: ${errorMessage(err)}`);
    }
    return { ok: !parts.some((p) => p.includes("FAILED")), message: parts.join(" · ") };
  } catch (err) {
    return toActionError(err);
  }
}

/** Disconnect a social account; tokens no longer used by any account are wiped (not kept "just in case"). */
export async function disconnectAccountAction(input: { accountId: string }): Promise<ActionResult> {
  try {
    const user = await requireActor("admin");
    const account = await db().socialAccount.findUnique({ where: { id: input.accountId } });
    if (!account || account.workspaceId !== user.workspaceId)
      throw new NotFoundError("Social account", input.accountId);
    await db().$transaction(async (tx) => {
      await tx.socialAccount.update({
        where: { id: account.id },
        data: { status: "DISCONNECTED", credentialId: null },
      });
      await tx.publication.updateMany({
        where: { socialAccountId: account.id, status: "SCHEDULED" },
        data: { lastError: "Account disconnected", errorCode: "ACCOUNT_DISCONNECTED" },
      });
      if (account.credentialId) {
        const stillUsed = await tx.socialAccount.count({ where: { credentialId: account.credentialId } });
        if (stillUsed === 0) {
          await tx.providerCredential.update({
            where: { id: account.credentialId },
            data: { status: "REVOKED", ciphertext: "", iv: "", authTag: "" },
          });
        }
      }
    });
    revalidatePath("/settings/providers");
    return { ok: true, message: "Disconnected. Scheduled posts for this account will not publish." };
  } catch (err) {
    return toActionError(err);
  }
}
