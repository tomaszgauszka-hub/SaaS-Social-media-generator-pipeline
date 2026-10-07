import type { GenerationJob } from "@cre/db";
import type { Logger } from "@cre/shared";
import type { PipelineContext } from "./context.ts";

/** Everything a job handler receives. */
export interface JobExecution {
  job: GenerationJob;
  payload: Record<string, unknown>;
  ctx: PipelineContext;
  log: Logger;
  signal: AbortSignal;
  /** per-job scratch directory (removed after the job) */
  workDir: string;
  /** 1-based attempt number */
  attempt: number;
}

export type JobHandler = (exec: JobExecution) => Promise<Record<string, unknown> | void>;

export function payloadString(exec: JobExecution, key: string): string {
  const v = exec.payload[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`job payload is missing "${key}"`);
  return v;
}

export function payloadOptionalString(exec: JobExecution, key: string): string | null {
  const v = exec.payload[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
