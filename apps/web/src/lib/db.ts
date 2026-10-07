import { getEnv } from "@cre/config";
import { getPrisma, type PrismaClient } from "@cre/db";

/** Process-wide Prisma client (cached on globalThis across dev hot reloads). */
export function db(): PrismaClient {
  return getPrisma();
}

export function env() {
  return getEnv();
}
