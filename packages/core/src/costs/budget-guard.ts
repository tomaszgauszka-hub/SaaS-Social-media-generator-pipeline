import {
  decimalFieldToMicros,
  microsToDecimal,
  type Prisma,
  type DbClient,
  type PrismaClient,
  type TxClient,
  type UsageOperation,
} from "@cre/db";
import { BudgetBlockedError, decimalToMicros, startOfPeriod, toJson, type Micros } from "@cre/shared";
import {
  evaluateBudget,
  type BudgetDecision,
  type BudgetLimits,
  type SpendSnapshot,
} from "./budget-evaluate.ts";

export interface UsageUnits {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  imageCount?: number;
  videoSeconds?: number;
  audioSeconds?: number;
  characters?: number;
}

export interface ReserveInput {
  workspaceId: string;
  brandId: string | null;
  projectId: string | null;
  jobId?: string | null;
  assetId?: string | null;
  runId?: string | null;
  provider: string;
  model: string;
  operation: UsageOperation;
  estimatedMicros: Micros;
  isMock: boolean;
  isAiVideo?: boolean;
  units?: UsageUnits;
  idempotencyKey: string;
  promptVersionId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface Reservation {
  usageId: string;
  /** an earlier reservation with the same idempotency key already existed */
  reused: boolean;
  status: "RESERVED" | "COMMITTED" | "RELEASED";
}

function limitsFromRow(
  row: {
    dailyLimitUsd: Prisma.Decimal | null;
    weeklyLimitUsd: Prisma.Decimal | null;
    monthlyLimitUsd: Prisma.Decimal | null;
    maxContentCostUsd: Prisma.Decimal | null;
    maxAiVideoCostUsd: Prisma.Decimal | null;
    maxRegenerations: number | null;
  } | null,
): BudgetLimits | null {
  if (!row) return null;
  const m = (v: Prisma.Decimal | null) => (v === null ? null : decimalFieldToMicros(v));
  return {
    dailyMicros: m(row.dailyLimitUsd),
    weeklyMicros: m(row.weeklyLimitUsd),
    monthlyMicros: m(row.monthlyLimitUsd),
    contentCapMicros: m(row.maxContentCostUsd),
    aiVideoCapMicros: m(row.maxAiVideoCostUsd),
    maxRegenerations: row.maxRegenerations,
  };
}

/**
 * BudgetGuard — the single gate in front of every paid operation.
 *
 * reserve(): inside a transaction holding a per-workspace advisory lock, compute spend (COMMITTED + RESERVED),
 * evaluate all limits and either insert a RESERVED usage row or throw BudgetBlockedError. Concurrent jobs
 * therefore cannot both squeeze under the same limit.
 */
export class BudgetGuard {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly opts: { hardDailyMicros: Micros | null; now?: () => Date } = { hardDailyMicros: null },
  ) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  async getLimits(
    db: DbClient,
    workspaceId: string,
    brandId: string | null,
  ): Promise<{ brand: BudgetLimits | null; workspace: BudgetLimits | null }> {
    const rows = await db.budget.findMany({
      where: {
        isEnforced: true,
        scopeKey: { in: [`workspace:${workspaceId}`, ...(brandId ? [`brand:${brandId}`] : [])] },
      },
    });
    return {
      workspace: limitsFromRow(rows.find((r) => r.scopeKey === `workspace:${workspaceId}`) ?? null),
      brand: brandId ? limitsFromRow(rows.find((r) => r.scopeKey === `brand:${brandId}`) ?? null) : null,
    };
  }

  async getSpend(
    db: DbClient,
    p: { workspaceId: string; brandId: string | null; projectId: string | null; timeZone: string },
  ): Promise<SpendSnapshot> {
    const now = this.now();
    const day = startOfPeriod(now, "day", p.timeZone);
    const week = startOfPeriod(now, "week", p.timeZone);
    const month = startOfPeriod(now, "month", p.timeZone);
    const earliest = new Date(Math.min(day.getTime(), week.getTime(), month.getTime()));
    const utcDay = startOfPeriod(now, "day", "UTC");
    const rows = await db.$queryRaw<
      {
        brand_day: unknown;
        brand_week: unknown;
        brand_month: unknown;
        ws_day: unknown;
        ws_week: unknown;
        ws_month: unknown;
        content_total: unknown;
        content_ai: unknown;
      }[]
    >`
      SELECT
        COALESCE(SUM(cost) FILTER (WHERE "brandId" = ${p.brandId} AND "createdAt" >= ${day}), 0)   AS brand_day,
        COALESCE(SUM(cost) FILTER (WHERE "brandId" = ${p.brandId} AND "createdAt" >= ${week}), 0)  AS brand_week,
        COALESCE(SUM(cost) FILTER (WHERE "brandId" = ${p.brandId} AND "createdAt" >= ${month}), 0) AS brand_month,
        COALESCE(SUM(cost) FILTER (WHERE "createdAt" >= ${day}), 0)   AS ws_day,
        COALESCE(SUM(cost) FILTER (WHERE "createdAt" >= ${week}), 0)  AS ws_week,
        COALESCE(SUM(cost) FILTER (WHERE "createdAt" >= ${month}), 0) AS ws_month,
        COALESCE(SUM(cost) FILTER (WHERE "projectId" = ${p.projectId}), 0) AS content_total,
        COALESCE(SUM(cost) FILTER (WHERE "projectId" = ${p.projectId} AND "isAiVideo"), 0) AS content_ai
      FROM (
        SELECT "brandId", "projectId", "isAiVideo", "createdAt", COALESCE("actualCostUsd", "estimatedCostUsd") AS cost
        FROM "GenerationUsage"
        WHERE "workspaceId" = ${p.workspaceId}
          AND status IN ('RESERVED', 'COMMITTED')
          AND ("createdAt" >= ${earliest} OR "projectId" = ${p.projectId})
      ) u`;
    const real = await db.$queryRaw<{ total: unknown }[]>`
      SELECT COALESCE(SUM(COALESCE("actualCostUsd", "estimatedCostUsd")), 0) AS total
      FROM "GenerationUsage"
      WHERE status IN ('RESERVED', 'COMMITTED') AND "isMock" = false AND "createdAt" >= ${utcDay}`;
    const r = rows[0]!;
    const m = (v: unknown) => decimalToMicros(v as string);
    return {
      brand: { day: m(r.brand_day), week: m(r.brand_week), month: m(r.brand_month) },
      workspace: { day: m(r.ws_day), week: m(r.ws_week), month: m(r.ws_month) },
      systemRealDay: m(real[0]?.total ?? 0),
      content: { total: m(r.content_total), aiVideo: m(r.content_ai) },
    };
  }

  private async timeZoneFor(db: DbClient, workspaceId: string): Promise<string> {
    const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } });
    return ws?.timezone ?? "UTC";
  }

  /** Read-only check (used by the router for planning; does not reserve). */
  async check(
    input: Omit<ReserveInput, "idempotencyKey" | "provider" | "model" | "operation"> & { db?: DbClient },
  ): Promise<BudgetDecision> {
    const db = input.db ?? this.prisma;
    // sequential: `db` may be an interactive transaction (one connection, no concurrent queries)
    const limits = await this.getLimits(db, input.workspaceId, input.brandId);
    const timeZone = await this.timeZoneFor(db, input.workspaceId);
    const spend = await this.getSpend(db, {
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      projectId: input.projectId,
      timeZone,
    });
    return evaluateBudget({
      requestMicros: input.estimatedMicros,
      isAiVideo: input.isAiVideo ?? false,
      isMock: input.isMock,
      brandLimits: limits.brand,
      workspaceLimits: limits.workspace,
      hardDailyMicros: this.opts.hardDailyMicros,
      spend,
    });
  }

  async reserve(input: ReserveInput): Promise<Reservation> {
    return this.prisma.$transaction(
      async (tx: TxClient) => {
        // Serialise budget decisions per workspace (released automatically at commit/rollback).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`budget:${input.workspaceId}`}))`;
        const existing = await tx.generationUsage.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (existing) return { usageId: existing.id, reused: true, status: existing.status };

        const decision = await this.check({ ...input, db: tx });
        if (!decision.allowed) throw new BudgetBlockedError(decision.reasons);

        const u = input.units ?? {};
        const usage = await tx.generationUsage.create({
          data: {
            workspaceId: input.workspaceId,
            brandId: input.brandId,
            projectId: input.projectId,
            jobId: input.jobId ?? null,
            assetId: input.assetId ?? null,
            runId: input.runId ?? null,
            provider: input.provider,
            model: input.model,
            operation: input.operation,
            status: "RESERVED",
            isMock: input.isMock,
            isAiVideo: input.isAiVideo ?? false,
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
            cachedInputTokens: u.cachedInputTokens ?? 0,
            imageCount: u.imageCount ?? 0,
            videoSeconds: u.videoSeconds ?? 0,
            audioSeconds: u.audioSeconds ?? 0,
            characters: u.characters ?? 0,
            estimatedCostUsd: microsToDecimal(input.estimatedMicros),
            idempotencyKey: input.idempotencyKey,
            promptVersionId: input.promptVersionId ?? null,
            // the guard's clock (simulated in demos/tests) so spend windows and reports line up
            createdAt: this.now(),
            ...(input.metadata ? { metadata: toJson(input.metadata) as Prisma.InputJsonValue } : {}),
          },
        });
        return { usageId: usage.id, reused: false, status: "RESERVED" as const };
      },
      { timeout: 20_000, maxWait: 15_000 },
    );
  }

  /** Settle a reservation with actual usage. `actualMicros` = provider-reported cost when available. */
  async commit(
    usageId: string,
    actual: UsageUnits & {
      estimatedMicros?: Micros;
      actualMicros?: Micros | null;
      model?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.prisma.generationUsage.updateMany({
      where: { id: usageId, status: { in: ["RESERVED", "COMMITTED"] } },
      data: {
        status: "COMMITTED",
        settledAt: this.now(),
        ...(actual.model ? { model: actual.model } : {}),
        ...(actual.inputTokens !== undefined ? { inputTokens: actual.inputTokens } : {}),
        ...(actual.outputTokens !== undefined ? { outputTokens: actual.outputTokens } : {}),
        ...(actual.cachedInputTokens !== undefined ? { cachedInputTokens: actual.cachedInputTokens } : {}),
        ...(actual.imageCount !== undefined ? { imageCount: actual.imageCount } : {}),
        ...(actual.videoSeconds !== undefined ? { videoSeconds: actual.videoSeconds } : {}),
        ...(actual.audioSeconds !== undefined ? { audioSeconds: actual.audioSeconds } : {}),
        ...(actual.characters !== undefined ? { characters: actual.characters } : {}),
        ...(actual.estimatedMicros !== undefined
          ? { estimatedCostUsd: microsToDecimal(actual.estimatedMicros) }
          : {}),
        ...(actual.actualMicros !== undefined && actual.actualMicros !== null
          ? { actualCostUsd: microsToDecimal(actual.actualMicros) }
          : {}),
        ...(actual.metadata ? { metadata: toJson(actual.metadata) as Prisma.InputJsonValue } : {}),
      },
    });
  }

  /** The operation did not happen / was not charged — free the reserved amount. */
  async release(usageId: string, reason: string): Promise<void> {
    await this.prisma.generationUsage.updateMany({
      where: { id: usageId, status: "RESERVED" },
      data: { status: "RELEASED", settledAt: this.now(), metadata: { releasedReason: reason } },
    });
  }

  /**
   * Reservations left behind by crashed workers. Real-provider reservations are conservatively committed at the
   * estimate (the provider may have charged); mock ones are released.
   */
  async reconcileStale(olderThanMs = 3 * 3600_000): Promise<{ committed: number; released: number }> {
    const cutoff = new Date(this.now().getTime() - olderThanMs);
    const released = await this.prisma.generationUsage.updateMany({
      where: { status: "RESERVED", isMock: true, createdAt: { lt: cutoff } },
      data: {
        status: "RELEASED",
        settledAt: this.now(),
        metadata: { releasedReason: "stale reservation (mock)" },
      },
    });
    const committed = await this.prisma.generationUsage.updateMany({
      where: { status: "RESERVED", isMock: false, createdAt: { lt: cutoff } },
      data: {
        status: "COMMITTED",
        settledAt: this.now(),
        metadata: { note: "stale reservation committed at estimate — verify against invoice" },
      },
    });
    return { committed: committed.count, released: released.count };
  }
}
