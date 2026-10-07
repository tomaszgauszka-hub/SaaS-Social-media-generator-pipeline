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
  ): Promise<T> {
    const reservation = await this.guard.reserve(reserve);
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
      if (err instanceof ProviderError && err.charged) {
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
