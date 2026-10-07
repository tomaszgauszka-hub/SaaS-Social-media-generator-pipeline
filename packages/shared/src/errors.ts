/**
 * Error taxonomy used across the pipeline. The job runner relies on these classes to decide whether a failure
 * is retried, sent to the dead-letter queue, or parked as BUDGET_BLOCKED.
 */

export type ErrorClass = "retryable" | "fatal" | "budget_blocked";

export interface AppErrorOptions {
  code?: string;
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, opts: AppErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.code = opts.code ?? "APP_ERROR";
    if (opts.details !== undefined) this.details = opts.details;
  }
}

/** Transient failure: timeouts, rate limits, 5xx, network resets. Safe to retry with backoff. */
export class RetryableError extends AppError {
  constructor(message: string, opts: AppErrorOptions = {}) {
    super(message, { code: "RETRYABLE", ...opts });
  }
}

/** Permanent failure: invalid input, auth errors, content rejected. Retrying will not help. */
export class FatalError extends AppError {
  constructor(message: string, opts: AppErrorOptions = {}) {
    super(message, { code: "FATAL", ...opts });
  }
}

export class TimeoutError extends RetryableError {
  constructor(message: string, opts: AppErrorOptions = {}) {
    super(message, { code: "TIMEOUT", ...opts });
  }
}

export class NotFoundError extends FatalError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, { code: "NOT_FOUND", details: { entity, id } });
  }
}

export class ValidationError extends FatalError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "VALIDATION", ...(details ? { details } : {}) });
  }
}

/** Optimistic-concurrency failure: the entity is no longer in the state the caller expected. */
export class StateConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "STATE_CONFLICT", ...(details ? { details } : {}) });
  }
}

export class InvalidTransitionError extends FatalError {
  constructor(entity: string, from: string, to: string) {
    super(`Invalid ${entity} transition ${from} → ${to}`, {
      code: "INVALID_TRANSITION",
      details: { entity, from, to },
    });
  }
}

export type BudgetScope = "system" | "workspace" | "brand" | "content";
export type BudgetLimitKind =
  "daily" | "weekly" | "monthly" | "content_cap" | "ai_video_cap" | "regenerations" | "hard_daily";

export interface BudgetBlockReason {
  scope: BudgetScope;
  limit: BudgetLimitKind;
  /** limit, current spend and requested amount in micro-USD (or counts for `regenerations`) */
  limitValue: number;
  currentValue: number;
  requestedValue: number;
  message: string;
}

/** A paid operation was NOT executed because it would exceed a budget. Never retried automatically. */
export class BudgetBlockedError extends AppError {
  readonly reasons: BudgetBlockReason[];

  constructor(reasons: BudgetBlockReason[]) {
    super(reasons.map((r) => r.message).join("; ") || "Budget exceeded", {
      code: "BUDGET_BLOCKED",
      details: { reasons },
    });
    this.reasons = reasons;
  }
}

/** Error raised by an external provider adapter, carrying HTTP status and retryability. */
export class ProviderError extends AppError {
  readonly provider: string;
  readonly status: number | undefined;
  readonly retryable: boolean;
  /** Whether the provider may have charged for the failed call (affects cost reservation release). */
  readonly charged: boolean;

  constructor(
    provider: string,
    message: string,
    opts: AppErrorOptions & { status?: number; retryable?: boolean; charged?: boolean } = {},
  ) {
    super(`[${provider}] ${message}`, { code: opts.code ?? "PROVIDER_ERROR", ...opts });
    this.provider = provider;
    this.status = opts.status;
    this.retryable = opts.retryable ?? isRetryableHttpStatus(opts.status);
    this.charged = opts.charged ?? false;
  }
}

export function isRetryableHttpStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // network-level failure
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export function classifyError(err: unknown): ErrorClass {
  if (err instanceof BudgetBlockedError) return "budget_blocked";
  if (err instanceof ProviderError) return err.retryable ? "retryable" : "fatal";
  if (err instanceof RetryableError) return "retryable";
  if (err instanceof StateConflictError) return "retryable";
  if (err instanceof FatalError) return "fatal";
  if (err instanceof Error) {
    if (err.name === "AbortError") return "retryable";
    // Node network errors
    const code = (err as Error & { code?: unknown }).code;
    if (
      typeof code === "string" &&
      /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|UND_ERR)/.test(code)
    ) {
      return "retryable";
    }
    if (err.name === "ZodError") return "fatal";
  }
  // Unknown errors are retried a bounded number of times by the job runner.
  return "retryable";
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
