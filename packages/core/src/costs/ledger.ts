import { ProviderError, type Logger, type Micros } from "@cre/shared";
import type { BudgetGuard, ReserveInput, UsageUnits } from "./budget-guard.ts";

export interface PaidOperationSettlement extends UsageUnits {
  /** recomputed estimate from actual units (e.g. real token counts) */
  estimatedMicros?: Micros;
  actualMicros?: Micros | null;
  model?: string;
  metadata?: Record<string, unknown>;
}

/**
 * CostLedger — "estimate → reserve → execute → commit/release" for every external AI/API call.
 * A blocked budget throws BudgetBlockedError BEFORE the provider is called.
 */
export class CostLedger {
  constructor(
    private readonly guard: BudgetGuard,
    private readonly logger?: Logger,
  ) {}

  get budgetGuard(): BudgetGuard {
    return this.guard;
  }

  async run<T>(
    reserve: ReserveInput,
    execute: () => Promise<T>,
    settle: (result: T) => PaidOperationSettlement,
    /** usage consumed by a failed call (e.g. invalid structured output after paid attempts) → committed */
    settleError?: (err: unknown) => PaidOperationSettlement | null,
  ): Promise<T> {
    const reservation = await this.guard.reserve(reserve);
    if (reservation.reused && reservation.status !== "RESERVED") {
      this.logger?.warn(
        { event: "COST", usageId: reservation.usageId },
        "usage key already settled — re-reserving is not possible",
      );
    }
    this.logger?.info(
      {
        event: "COST",
        phase: "reserved",
        usageId: reservation.usageId,
        provider: reserve.provider,
        model: reserve.model,
        operation: reserve.operation,
        estimatedMicros: reserve.estimatedMicros,
        isMock: reserve.isMock,
        reused: reservation.reused,
      },
      "cost reserved",
    );
    let result: T;
    try {
      result = await execute();
    } catch (err) {
      const partial = settleError?.(err) ?? null;
      if (partial) {
        await this.guard.commit(reservation.usageId, {
          ...partial,
          metadata: { ...(partial.metadata ?? {}), failed: true, error: (err as Error).message },
        });
        this.logger?.warn(
          { event: "COST", usageId: reservation.usageId },
          "call failed after consuming usage — committed actual usage",
        );
      } else if (err instanceof ProviderError && err.charged) {
        await this.guard.commit(reservation.usageId, {
          metadata: { failedButCharged: true, error: err.message },
        });
        this.logger?.warn(
          { event: "COST", usageId: reservation.usageId },
          "provider failed but charged — committed at estimate",
        );
      } else {
        await this.guard.release(reservation.usageId, (err as Error).message ?? "failed");
      }
      throw err;
    }
    const settlement = settle(result);
    await this.guard.commit(reservation.usageId, settlement);
    this.logger?.info(
      {
        event: "COST",
        phase: "committed",
        usageId: reservation.usageId,
        estimatedMicros: settlement.estimatedMicros ?? reserve.estimatedMicros,
        actualMicros: settlement.actualMicros ?? null,
      },
      "cost committed",
    );
    return result;
  }
}
