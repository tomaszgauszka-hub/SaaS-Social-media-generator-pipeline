import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "prisma/config";

// Prisma 7 does not load .env automatically. The monorepo keeps a single .env at the repository root.
const here = typeof import.meta.dirname === "string" ? import.meta.dirname : process.cwd();
const rootEnv = path.resolve(here, "../../.env");
if (fs.existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx src/seed/index.ts",
  },
  datasource: {
    // A placeholder keeps `prisma generate` working without a database; migrate commands need the real URL.
    url: process.env.DATABASE_URL ?? "postgresql://cre:cre@localhost:5432/cre",
  },
});
