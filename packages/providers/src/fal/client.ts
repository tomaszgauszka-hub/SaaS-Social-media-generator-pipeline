import { FatalError, ProviderError, sleep } from "@cre/shared";
import { requestJson } from "../http.ts";
import type { ExecContext } from "../types.ts";

/**
 * fal.ai queue API client.
 *   POST https://queue.fal.run/<model>          → { request_id, status_url, response_url }
 *   GET  <status_url>                           → { status: IN_QUEUE | IN_PROGRESS | COMPLETED }
 *   GET  <response_url>                         → model output
 *
 * Idempotency: the response_url is reported through ctx.onExternalJobId *before* polling, and persisted on
 * the Asset. A restarted worker passes it back as ctx.externalJobId and resumes polling instead of paying
 * for a second generation.
 */
export interface FalClientOptions {
  apiKey: string | undefined;
  baseUrl?: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

interface FalSubmitResponse {
  request_id: string;
  status_url?: string;
  response_url?: string;
}

interface FalStatusResponse {
  /** IN_QUEUE | IN_PROGRESS | COMPLETED */
  status: string;
  error?: string;
}

export class FalClient {
  private readonly baseUrl: string;

  constructor(private readonly opts: FalClientOptions) {
    this.baseUrl = opts.baseUrl ?? "https://queue.fal.run";
  }

  get configured(): boolean {
    return Boolean(this.opts.apiKey);
  }

  private headers(): Record<string, string> {
    if (!this.opts.apiKey) throw new FatalError("FAL_KEY is not configured");
    return { Authorization: `Key ${this.opts.apiKey}`, "Content-Type": "application/json" };
  }

  async run<T>(
    model: string,
    input: Record<string, unknown>,
    ctx: ExecContext,
    timeoutMs = 600_000,
  ): Promise<{ output: T; requestId: string }> {
    let responseUrl = ctx.externalJobId ?? undefined;
    if (!responseUrl) {
      const submitted = await requestJson<FalSubmitResponse>(
        "fal",
        `${this.baseUrl}/${model}`,
        { method: "POST", headers: this.headers(), body: JSON.stringify(input) },
        { timeoutMs: 60_000, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      );
      responseUrl = submitted.response_url ?? `${this.baseUrl}/${model}/requests/${submitted.request_id}`;
      await ctx.onExternalJobId?.(responseUrl);
      ctx.logger?.info({ model, requestId: submitted.request_id }, "fal request submitted");
    } else {
      ctx.logger?.info({ model }, "resuming fal request from previous attempt");
    }

    const statusUrl = `${responseUrl}/status`;
    const deadline = Date.now() + Math.min(timeoutMs, this.opts.maxWaitMs ?? timeoutMs);
    const interval = this.opts.pollIntervalMs ?? 2_000;
    for (;;) {
      const status = await requestJson<FalStatusResponse>(
        "fal",
        statusUrl,
        { method: "GET", headers: this.headers() },
        { timeoutMs: 30_000, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      );
      // a failed request can be reported as COMPLETED + error, so the error check comes first
      if (status.error)
        throw new ProviderError("fal", `request failed: ${status.error}`, {
          retryable: false,
          charged: true,
        });
      if (status.status === "COMPLETED") break;
      if (Date.now() > deadline) {
        throw new ProviderError("fal", `request did not complete within ${timeoutMs} ms`, {
          retryable: true,
        });
      }
      await sleep(interval, ctx.signal);
    }
    const output = await requestJson<T>(
      "fal",
      responseUrl,
      { method: "GET", headers: this.headers() },
      { timeoutMs: 60_000, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    const requestId = responseUrl.split("/").pop() ?? responseUrl;
    return { output, requestId };
  }
}
