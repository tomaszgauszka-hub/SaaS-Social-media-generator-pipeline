import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, seedDatabase, type PrismaClient } from "@cre/db";
import { testDatabaseUrl, truncateAll } from "@cre/db/testing";
import { InvalidTransitionError, StateConflictError } from "@cre/shared";
import { transitionContent } from "./transitions.ts";

let prisma: PrismaClient;
let brandId: string;
let workspaceId: string;

beforeAll(async () => {
  prisma = createPrismaClient({ url: testDatabaseUrl() });
  await truncateAll(prisma);
  const seed = await seedDatabase(prisma, { ownerEmail: "t@example.com", ownerPassword: "password123" });
  workspaceId = seed.workspaceId;
  brandId = seed.brandIds["demo-tools"]!;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function newProject() {
  return prisma.contentProject.create({ data: { workspaceId, brandId, title: "t" } });
}

describe("transitionContent (database)", () => {
  it("moves through valid states and writes audit logs", async () => {
    const p = await newProject();
    await transitionContent(prisma, { projectId: p.id, from: "IDEA", to: "RESEARCHING", actor: "WORKER" });
    await transitionContent(prisma, {
      projectId: p.id,
      from: "RESEARCHING",
      to: "SCRIPTING",
      actor: "WORKER",
    });
    const after = await prisma.contentProject.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.status).toBe("SCRIPTING");
    const logs = await prisma.auditLog.count({ where: { entityId: p.id, action: "content.status" } });
    expect(logs).toBe(2);
  });

  it("rejects invalid transitions before touching the database", async () => {
    const p = await newProject();
    await expect(
      transitionContent(prisma, { projectId: p.id, from: "IDEA", to: "PUBLISHED", actor: "SYSTEM" }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("detects concurrent modification (optimistic concurrency)", async () => {
    const p = await newProject();
    const attempts = await Promise.allSettled([
      transitionContent(prisma, { projectId: p.id, from: "IDEA", to: "RESEARCHING", actor: "WORKER" }),
      transitionContent(prisma, { projectId: p.id, from: "IDEA", to: "RESEARCHING", actor: "WORKER" }),
    ]);
    const ok = attempts.filter((a) => a.status === "fulfilled");
    const conflicts = attempts.filter(
      (a) => a.status === "rejected" && (a.reason as unknown) instanceof StateConflictError,
    );
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
  });

  it("stores resume information when blocked", async () => {
    const p = await newProject();
    await transitionContent(prisma, { projectId: p.id, from: "IDEA", to: "RESEARCHING", actor: "WORKER" });
    await transitionContent(prisma, {
      projectId: p.id,
      from: "RESEARCHING",
      to: "BUDGET_BLOCKED",
      actor: "WORKER",
      data: { resumeStatus: "RESEARCHING", blockedReasons: [{ limit: "daily" }] },
    });
    const blocked = await prisma.contentProject.findUniqueOrThrow({ where: { id: p.id } });
    expect(blocked.status).toBe("BUDGET_BLOCKED");
    expect(blocked.resumeStatus).toBe("RESEARCHING");
  });
});
