import { execFileSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { testDatabaseUrl } from "@cre/db/testing";

/**
 * Vitest global setup for the "integration" project:
 *  1. create the test database if missing
 *  2. apply migrations (prisma migrate deploy)
 */
export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const target = new URL(url);
  const dbName = target.pathname.replace(/^\//, "");
  const admin = new URL(url);
  admin.pathname = "/postgres";

  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Integration tests need PostgreSQL (tried ${admin.host}). Start it with \`docker compose up -d\`.`,
      { cause: err },
    );
  }
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${dbName.replace(/"/g, "")}"`);
  } finally {
    await client.end();
  }

  const dbPkg = path.resolve(import.meta.dirname, "../packages/db");
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: dbPkg,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  process.env.DATABASE_URL = url;
}
