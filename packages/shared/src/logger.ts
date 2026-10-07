import { pino, type Logger, type LoggerOptions } from "pino";

export type { Logger } from "pino";

/**
 * Structured JSON logger (pino). Pipeline code always logs with a child logger carrying
 * runId / brandId / contentId / jobId so a single run can be reconstructed from logs.
 *
 * Pretty output for local development: `pnpm worker | npx pino-pretty`.
 */
export interface PipelineLogContext {
  runId?: string | null;
  brandId?: string | null;
  contentId?: string | null;
  jobId?: string | null;
  queue?: string;
  jobType?: string;
}

/** Event names required by the observability spec. */
export const LogEvent = {
  START: "START",
  SUCCESS: "SUCCESS",
  FAILURE: "FAILURE",
  RETRY: "RETRY",
  COST: "COST",
  BUDGET_BLOCKED: "BUDGET_BLOCKED",
} as const;
export type LogEvent = (typeof LogEvent)[keyof typeof LogEvent];

const REDACT_PATHS = [
  "password",
  "*.password",
  "apiKey",
  "*.apiKey",
  "token",
  "*.token",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "*.headers.authorization",
  "secret",
  "*.secret",
];

let rootLogger: Logger | undefined;

export function createLogger(options: { service: string; level?: string } & Partial<LoggerOptions>): Logger {
  const { service, level, ...rest } = options;
  return pino({
    level: level ?? process.env.LOG_LEVEL ?? "info",
    base: { service },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...rest,
  });
}

/** Process-wide logger; services call `setRootLogger` at startup to name themselves. */
export function getLogger(): Logger {
  rootLogger ??= createLogger({ service: process.env.CRE_SERVICE ?? "cre" });
  return rootLogger;
}

export function setRootLogger(logger: Logger): void {
  rootLogger = logger;
}

export function pipelineLogger(base: Logger, ctx: PipelineLogContext): Logger {
  const bindings: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (typeof v === "string" && v.length > 0) bindings[k] = v;
  }
  return base.child(bindings);
}
