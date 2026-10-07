import type { RegisteredPrompt } from "@cre/ai";
import type { PrismaClient } from "@cre/db";
import { FatalError } from "@cre/shared";

/** per Prisma client (tests use a separate database) → prompt id → PromptVersion row id */
const caches = new WeakMap<PrismaClient, Map<string, string>>();

/**
 * Make sure a PromptVersion row exists for (key, version) and that the stored hash matches the code.
 * A mismatch means a prompt was edited without bumping its version — refuse to run so every generation stays
 * traceable to the exact prompt text that produced it.
 */
export async function ensurePromptVersion(
  prisma: PrismaClient,
  prompt: RegisteredPrompt<unknown, unknown>,
): Promise<string> {
  let cache = caches.get(prisma);
  if (!cache) {
    cache = new Map();
    caches.set(prisma, cache);
  }
  const cached = cache.get(prompt.id);
  if (cached) return cached;
  await prisma.promptVersion.createMany({
    data: [
      {
        key: prompt.key,
        version: prompt.version,
        contentHash: prompt.contentHash,
        system: prompt.system,
        template: prompt.template,
        schemaName: prompt.schemaName,
      },
    ],
    skipDuplicates: true,
  });
  const row = await prisma.promptVersion.findUniqueOrThrow({
    where: { key_version: { key: prompt.key, version: prompt.version } },
  });
  if (row.contentHash !== prompt.contentHash) {
    throw new FatalError(
      `Prompt ${prompt.id} changed without a version bump (stored hash ${row.contentHash.slice(0, 12)}, code ${prompt.contentHash.slice(0, 12)}). Increment its version.`,
    );
  }
  cache.set(prompt.id, row.id);
  return row.id;
}

export function clearPromptCache(prisma: PrismaClient): void {
  caches.delete(prisma);
}
