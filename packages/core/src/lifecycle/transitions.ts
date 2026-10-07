import type { ContentStatus, DbClient, Prisma, PublicationStatus, VariantStatus } from "@cre/db";
import { StateConflictError, toJson, type JsonValue } from "@cre/shared";
import { contentMachine, publicationMachine, variantMachine } from "./state-machine.ts";

export interface TransitionActor {
  actor: "USER" | "SYSTEM" | "WORKER";
  userId?: string | null;
}

export interface ContentTransitionInput extends TransitionActor {
  projectId: string;
  /** expected current status (optimistic concurrency); several allowed */
  from: ContentStatus | readonly ContentStatus[];
  to: ContentStatus;
  reason?: string;
  data?: Omit<Prisma.ContentProjectUncheckedUpdateManyInput, "status" | "statusChangedAt">;
  audit?: Record<string, unknown>;
}

/**
 * Move a ContentProject between states. Validates the transition table, then updates with
 * `WHERE id = ? AND status IN (from)` so concurrent actors cannot both win. Writes an AuditLog row.
 */
export async function transitionContent(db: DbClient, input: ContentTransitionInput): Promise<void> {
  const fromList = (Array.isArray(input.from) ? input.from : [input.from]) as ContentStatus[];
  for (const from of fromList) contentMachine.assert(from, input.to);

  const result = await db.contentProject.updateMany({
    where: { id: input.projectId, status: { in: fromList } },
    data: { ...input.data, status: input.to, statusChangedAt: new Date() },
  });
  if (result.count === 0) {
    const current = await db.contentProject.findUnique({
      where: { id: input.projectId },
      select: { status: true },
    });
    throw new StateConflictError(
      `ContentProject ${input.projectId} is ${current?.status ?? "missing"}, expected ${fromList.join("|")} for → ${input.to}`,
      { projectId: input.projectId, current: current?.status ?? null, expected: fromList, to: input.to },
    );
  }

  const project = await db.contentProject.findUnique({
    where: { id: input.projectId },
    select: { workspaceId: true },
  });
  await db.auditLog.create({
    data: {
      workspaceId: project?.workspaceId ?? null,
      userId: input.userId ?? null,
      actor: input.actor,
      action: "content.status",
      entityType: "ContentProject",
      entityId: input.projectId,
      data: toJson({
        from: fromList,
        to: input.to,
        reason: input.reason ?? null,
        ...input.audit,
      }) as Prisma.InputJsonValue,
    },
  });
}

export async function transitionVariant(
  db: DbClient,
  input: {
    variantId: string;
    from: VariantStatus | readonly VariantStatus[];
    to: VariantStatus;
    data?: Omit<Prisma.ContentVariantUncheckedUpdateManyInput, "status">;
  },
): Promise<void> {
  const fromList = (Array.isArray(input.from) ? input.from : [input.from]) as VariantStatus[];
  for (const from of fromList) variantMachine.assert(from, input.to);
  const result = await db.contentVariant.updateMany({
    where: { id: input.variantId, status: { in: fromList } },
    data: { ...input.data, status: input.to },
  });
  if (result.count === 0) {
    throw new StateConflictError(`ContentVariant ${input.variantId} not in ${fromList.join("|")}`, {
      variantId: input.variantId,
    });
  }
}

export async function transitionPublication(
  db: DbClient,
  input: {
    publicationId: string;
    from: PublicationStatus | readonly PublicationStatus[];
    to: PublicationStatus;
    data?: Omit<Prisma.PublicationUncheckedUpdateManyInput, "status">;
  },
): Promise<void> {
  const fromList = (Array.isArray(input.from) ? input.from : [input.from]) as PublicationStatus[];
  for (const from of fromList) publicationMachine.assert(from, input.to);
  const result = await db.publication.updateMany({
    where: { id: input.publicationId, status: { in: fromList } },
    data: { ...input.data, status: input.to },
  });
  if (result.count === 0) {
    throw new StateConflictError(`Publication ${input.publicationId} not in ${fromList.join("|")}`, {
      publicationId: input.publicationId,
    });
  }
}

/** Convenience: JSON value for audit payloads. */
export function auditData(value: unknown): JsonValue {
  return toJson(value);
}
