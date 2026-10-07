import { getEnv } from "@cre/config";
import { createPrismaClient } from "../client.ts";
import { seedDatabase } from "./seed.ts";

/** CLI: `pnpm db:seed` */
async function main() {
  const env = getEnv();
  const prisma = createPrismaClient();
  try {
    const result = await seedDatabase(prisma, {
      ownerEmail: env.SEED_OWNER_EMAIL,
      ownerPassword: env.SEED_OWNER_PASSWORD,
      log: (m) => console.log(`  ✓ ${m}`),
    });
    console.log(
      `\nSeed complete: ${Object.keys(result.brandIds).length} brands, ${Object.keys(result.productIds).length} products.`,
    );
    console.log(`Log in with ${env.SEED_OWNER_EMAIL} / (SEED_OWNER_PASSWORD from .env)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
