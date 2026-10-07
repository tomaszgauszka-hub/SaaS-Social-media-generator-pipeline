import { getEnv, loadRootEnvFile } from "@cre/config";
import type { PrismaClient } from "./generated/prisma/client.ts";

/**
 * Test helpers (integration tests only).
 * The test database is DATABASE_URL_TEST, or DATABASE_URL with "_test" appended to the database name.
 */
export function testDatabaseUrl(): string {
  loadRootEnvFile();
  if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;
  const base = process.env.DATABASE_URL ?? getEnv().DATABASE_URL;
  const url = new URL(base);
  const dbName = url.pathname.replace(/^\//, "") || "cre";
  url.pathname = `/${dbName.endsWith("_test") ? dbName : `${dbName}_test`}`;
  return url.toString();
}

/** Remove all rows from all application tables (keeps the migration history). */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
