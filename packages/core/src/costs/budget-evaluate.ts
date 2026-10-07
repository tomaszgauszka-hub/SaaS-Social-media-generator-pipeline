import { formatUsd, type BudgetBlockReason, type BudgetScope, type Micros } from "@cre/shared";

/**
 * Pure budget evaluation. Given limits, current spend (committed + outstanding reservations) and the cost of
 * the operation about to run, decide whether it may run. Unit-tested exhaustively; the DB guard only gathers
 * the numbers and serialises access.
 */
export interface BudgetLimits {
  dailyMicros: Micros | null;
  weeklyMicros: Micros | null;
  monthlyMicros: Micros | null;
  contentCapMicros: Micros | null;
  aiVideoCapMicros: Micros | null;
  maxRegenerations: number | null;
}

export interface PeriodSpend {
  day: Micros;
  week: Micros;
  month: Micros;
}

export interface SpendSnapshot {
  brand: PeriodSpend;
  workspace: PeriodSpend;
  /** real (non-mock) spend across all workspaces today (UTC) — for the HARD_DAILY_BUDGET_USD fail-safe */
  systemRealDay: Micros;
  content: { total: Micros; aiVideo: Micros };
}

export interface BudgetCheckInput {
  requestMicros: Micros;
  isAiVideo: boolean;
  /** mock operations are excluded from the system-wide real-money cap */
  isMock: boolean;
  brandLimits: BudgetLimits | null;
  workspaceLimits: BudgetLimits | null;
  hardDailyMicros: Micros | null;
  spend: SpendSnapshot;
}

export interface BudgetDecision {
  allowed: boolean;
  reasons: BudgetBlockReason[];
  /** smallest remaining headroom across all applicable period limits (null = unlimited) */
  headroomMicros: Micros | null;
}

export const EMPTY_LIMITS: BudgetLimits = {
  dailyMicros: null,
  weeklyMicros: null,
  monthlyMicros: null,
  contentCapMicros: null,
  aiVideoCapMicros: null,
  maxRegenerations: null,
};

export function evaluateBudget(input: BudgetCheckInput): BudgetDecision {
  const reasons: BudgetBlockReason[] = [];
  const headrooms: Micros[] = [];
  const req = input.requestMicros;

  const check = (
    scope: BudgetScope,
    limit: BudgetBlockReason["limit"],
    limitValue: Micros | null,
    current: Micros,
    label: string,
  ) => {
    if (limitValue === null) return;
    headrooms.push(limitValue - current);
    if (req > 0 && current + req > limitValue) {
      reasons.push({
        scope,
        limit,
        limitValue,
        currentValue: current,
        requestedValue: req,
        message: `${label}: ${formatUsd(current)} spent + ${formatUsd(req)} requested exceeds ${formatUsd(limitValue)}`,
      });
    }
  };

  const b = input.brandLimits;
  if (b) {
    check("brand", "daily", b.dailyMicros, input.spend.brand.day, "Brand daily budget");
    check("brand", "weekly", b.weeklyMicros, input.spend.brand.week, "Brand weekly budget");
    check("brand", "monthly", b.monthlyMicros, input.spend.brand.month, "Brand monthly budget");
    check("content", "content_cap", b.contentCapMicros, input.spend.content.total, "Max cost per content");
    if (input.isAiVideo)
      check(
        "content",
        "ai_video_cap",
        b.aiVideoCapMicros,
        input.spend.content.aiVideo,
        "Max AI video cost per content",
      );
  }
  const w = input.workspaceLimits;
  if (w) {
    check("workspace", "daily", w.dailyMicros, input.spend.workspace.day, "Global daily API budget");
    check("workspace", "weekly", w.weeklyMicros, input.spend.workspace.week, "Global weekly API budget");
    check("workspace", "monthly", w.monthlyMicros, input.spend.workspace.month, "Global monthly API budget");
  }
  if (!input.isMock)
    check("system", "hard_daily", input.hardDailyMicros, input.spend.systemRealDay, "System hard daily cap");

  return {
    allowed: reasons.length === 0,
    reasons,
    headroomMicros: headrooms.length ? Math.max(0, Math.min(...headrooms)) : null,
  };
}

export function evaluateRegenerationLimit(
  limits: BudgetLimits | null,
  regenerationCount: number,
): BudgetBlockReason | null {
  if (!limits || limits.maxRegenerations === null) return null;
  if (regenerationCount < limits.maxRegenerations) return null;
  return {
    scope: "content",
    limit: "regenerations",
    limitValue: limits.maxRegenerations,
    currentValue: regenerationCount,
    requestedValue: 1,
    message: `Regeneration limit reached (${regenerationCount}/${limits.maxRegenerations})`,
  };
}
