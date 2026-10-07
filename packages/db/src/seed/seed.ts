import { hashPassword } from "@cre/shared";
import type { PrismaClient } from "../generated/prisma/client.ts";
import { BRANDS, DEFAULT_SLOTS, PROGRAMS, SYSTEM_TEMPLATES } from "./data.ts";

export interface SeedOptions {
  ownerEmail: string;
  ownerPassword: string;
  workspaceSlug?: string;
  log?: (message: string) => void;
}

export interface SeedResult {
  workspaceId: string;
  ownerId: string;
  brandIds: Record<string, string>;
  productIds: Record<string, string>;
}

/**
 * Idempotent seed: safe to run repeatedly (upserts on natural keys; slots/rules are replaced per brand).
 */
export async function seedDatabase(prisma: PrismaClient, opts: SeedOptions): Promise<SeedResult> {
  const log = opts.log ?? (() => undefined);
  const slug = opts.workspaceSlug ?? "demo";

  const workspace = await prisma.workspace.upsert({
    where: { slug },
    update: {},
    create: { name: "Demo Workspace", slug, timezone: "UTC" },
  });
  log(`workspace ${workspace.slug} (${workspace.id})`);

  const existingOwner = await prisma.user.findUnique({ where: { email: opts.ownerEmail } });
  const owner =
    existingOwner ??
    (await prisma.user.create({
      data: { email: opts.ownerEmail, name: "Owner", passwordHash: await hashPassword(opts.ownerPassword) },
    }));
  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    update: { role: "OWNER" },
    create: { userId: owner.id, workspaceId: workspace.id, role: "OWNER" },
  });
  log(`owner ${owner.email}`);

  // Global (workspace) API budget
  await prisma.budget.upsert({
    where: { scopeKey: `workspace:${workspace.id}` },
    update: {},
    create: {
      workspaceId: workspace.id,
      scopeKey: `workspace:${workspace.id}`,
      dailyLimitUsd: "3.00",
      monthlyLimitUsd: "40.00",
    },
  });

  const programIds: Record<string, string> = {};
  for (const p of PROGRAMS) {
    const program = await prisma.affiliateProgram.upsert({
      where: { workspaceId_name: { workspaceId: workspace.id, name: p.name } },
      update: {},
      create: { workspaceId: workspace.id, ...p },
    });
    programIds[p.name] = program.id;
  }

  for (const t of SYSTEM_TEMPLATES) {
    await prisma.template.upsert({
      where: { scope_key_version: { scope: "system", key: t.key, version: 1 } },
      update: { name: t.name, spec: t.spec },
      create: { scope: "system", key: t.key, name: t.name, kind: t.kind, version: 1, spec: t.spec },
    });
  }

  const brandIds: Record<string, string> = {};
  const productIds: Record<string, string> = {};

  for (const b of BRANDS) {
    const { products, disclosures, handle, ...brandData } = b;
    const brand = await prisma.brand.upsert({
      where: { workspaceId_slug: { workspaceId: workspace.id, slug: b.slug } },
      update: {},
      create: { workspaceId: workspace.id, ...brandData, qaThreshold: 70, ideasPerCycle: 2 },
    });
    brandIds[b.slug] = brand.id;
    log(`brand ${brand.name}`);

    await prisma.budget.upsert({
      where: { scopeKey: `brand:${brand.id}` },
      update: {},
      create: {
        workspaceId: workspace.id,
        brandId: brand.id,
        scopeKey: `brand:${brand.id}`,
        dailyLimitUsd: "1.00",
        weeklyLimitUsd: "5.00",
        monthlyLimitUsd: "15.00",
        maxContentCostUsd: "0.50",
        maxAiVideoCostUsd: "0.30",
        maxRegenerations: 3,
      },
    });

    // Mock social accounts (one per target platform)
    const accountIds: Record<string, string> = {};
    for (const platform of b.targetPlatforms) {
      const account = await prisma.socialAccount.upsert({
        where: { brandId_platform_handle: { brandId: brand.id, platform, handle: `@${handle}` } },
        update: {},
        create: {
          workspaceId: workspace.id,
          brandId: brand.id,
          platform,
          handle: `@${handle}`,
          displayName: `${b.name} (${platform.toLowerCase()} mock)`,
          status: "MOCK",
          isMock: true,
        },
      });
      accountIds[platform] = account.id;
    }

    // Publishing slots: replace with defaults (TikTok 12:00, Instagram 15:00, Facebook 18:00)
    await prisma.publishingSlot.deleteMany({ where: { brandId: brand.id } });
    await prisma.publishingSlot.createMany({
      data: DEFAULT_SLOTS.filter((s) => b.targetPlatforms.includes(s.platform)).map((s) => ({
        brandId: brand.id,
        platform: s.platform,
        timeOfDay: s.timeOfDay,
        socialAccountId: accountIds[s.platform] ?? null,
      })),
    });

    await prisma.disclosureRule.deleteMany({ where: { brandId: brand.id } });
    await prisma.disclosureRule.createMany({
      data: disclosures.map((d) => ({ brandId: brand.id, isRequired: true, ...d })),
    });

    for (const p of products) {
      const { program, facts, economicOutcome: _economicOutcome, ...productData } = p;
      const programId = programIds[program];
      const product = await prisma.product.upsert({
        where: { brandId_sku: { brandId: brand.id, sku: p.sku } },
        update: {},
        create: {
          workspaceId: workspace.id,
          brandId: brand.id,
          ...productData,
          currency: "USD",
          priceCheckedAt: p.price ? new Date() : null,
          source: "SEED",
          sourceUrl: p.productUrl,
          facts,
          status: "ACTIVE",
        },
      });
      productIds[p.sku] = product.id;

      const existingOffer = await prisma.offer.findFirst({
        where: { productId: product.id, isPrimary: true },
      });
      const offer =
        existingOffer ??
        (await prisma.offer.create({
          data: {
            productId: product.id,
            affiliateProgramId: programId ?? null,
            title: p.title,
            price: p.price,
            commissionRate: p.commissionRate,
            commissionFixedUsd: p.commissionFixedUsd ?? null,
            landingUrl: p.productUrl,
            isPrimary: true,
          },
        }));
      const existingLink = await prisma.affiliateLink.findFirst({ where: { offerId: offer.id } });
      if (!existingLink) {
        const programDef = PROGRAMS.find((x) => x.name === program);
        await prisma.affiliateLink.create({
          data: {
            productId: product.id,
            offerId: offer.id,
            affiliateProgramId: programId ?? null,
            url: p.affiliateUrl,
            subIdParam: programDef?.subIdParam ?? null,
          },
        });
      }
    }
  }

  return { workspaceId: workspace.id, ownerId: owner.id, brandIds, productIds };
}
