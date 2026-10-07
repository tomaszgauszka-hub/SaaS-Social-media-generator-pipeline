import { llmCostMicros } from "@cre/config";
import { FatalError, ProviderError } from "@cre/shared";
import { classifyPrompt, scorePrompt } from "../prompts/scoring/generic.ts";
import { renderPrompt } from "../prompts/registry.ts";
import { runStructured } from "../structured.ts";
import type {
  ClassifyRequest,
  GenerateTextRequest,
  LlmCallResult,
  LlmCostEstimate,
  LlmCostEstimateRequest,
  LlmHealth,
  LLMProvider,
  ScoreRequest,
  StructuredRequest,
  StructuredResult,
} from "../types.ts";

export interface OpenAICompatibleOptions {
  name: string;
  baseUrl: string;
  apiKey: string | undefined;
  defaultModel: string;
  /** provider key in the pricing catalog */
  pricingProvider: string;
  supportsJsonMode?: boolean;
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** DeepSeek context caching */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    /** OpenAI context caching */
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string };
}

/**
 * Any OpenAI-compatible Chat Completions API (DeepSeek, OpenAI, vLLM, Ollama, OpenRouter …).
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly isMock = false;
  readonly name: string;
  readonly defaultModel: string;

  constructor(protected readonly opts: OpenAICompatibleOptions) {
    this.name = opts.name;
    this.defaultModel = opts.defaultModel;
  }

  async healthCheck(): Promise<LlmHealth> {
    if (!this.opts.apiKey)
      return { ok: false, provider: this.name, isMock: false, message: "API key not configured" };
    const started = Date.now();
    try {
      const res = await fetch(`${this.opts.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      return {
        ok: res.ok,
        provider: this.name,
        isMock: false,
        latencyMs: Date.now() - started,
        message: res.ok ? "reachable" : `HTTP ${res.status}`,
      };
    } catch (err) {
      return { ok: false, provider: this.name, isMock: false, message: (err as Error).message };
    }
  }

  estimateCost(req: LlmCostEstimateRequest): LlmCostEstimate {
    const model = req.model ?? this.defaultModel;
    const perCall = llmCostMicros(this.opts.pricingProvider, model, {
      inputTokens: req.inputTokens,
      outputTokens: req.maxOutputTokens,
    });
    return { provider: this.name, model, estimatedMicros: perCall * (req.calls ?? 1), isMock: false };
  }

  async generateText(req: GenerateTextRequest): Promise<LlmCallResult> {
    if (!this.opts.apiKey) throw new FatalError(`${this.name}: API key is not configured`);
    const model = req.model ?? this.defaultModel;
    const body: Record<string, unknown> = {
      model,
      messages: req.messages,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxOutputTokens ?? 2000,
      stream: false,
    };
    if (req.jsonMode && this.opts.supportsJsonMode !== false) body.response_format = { type: "json_object" };

    const started = Date.now();
    const timeout = AbortSignal.timeout(req.timeoutMs ?? this.opts.timeoutMs ?? 120_000);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw new ProviderError(this.name, `request failed: ${(err as Error).message}`, {
        cause: err,
        retryable: true,
      });
    }
    const text = await res.text();
    if (!res.ok) {
      // 402 = insufficient balance (DeepSeek) → not retryable; 429/5xx → retryable
      throw new ProviderError(this.name, `HTTP ${res.status}: ${text.slice(0, 400)}`, { status: res.status });
    }
    let data: ChatCompletionResponse;
    try {
      data = JSON.parse(text) as ChatCompletionResponse;
    } catch (err) {
      throw new ProviderError(this.name, "invalid JSON response", {
        cause: err,
        retryable: true,
        charged: true,
      });
    }
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? "";
    const usage = data.usage ?? {};
    const inputTokens = usage.prompt_tokens ?? 0;
    const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      text: content,
      usage: { inputTokens, outputTokens: usage.completion_tokens ?? 0, cachedInputTokens: cached },
      provider: this.name,
      model: data.model ?? model,
      latencyMs: Date.now() - started,
      ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
      isMock: false,
    };
  }

  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return runStructured((r) => this.generateText(r), req);
  }

  classify(req: ClassifyRequest): Promise<StructuredResult<{ label: string; confidence: number }>> {
    const ctx = {
      text: req.text,
      labels: req.labels,
      instructions: req.instructions ?? "Classify the text.",
    };
    return this.generateStructured({
      messages: renderPrompt(classifyPrompt, ctx),
      schema: classifyPrompt.schema,
      schemaName: classifyPrompt.schemaName,
      temperature: classifyPrompt.temperature,
      maxOutputTokens: classifyPrompt.maxOutputTokens,
      promptKey: classifyPrompt.key,
      mockContext: ctx,
      ...(req.signal ? { signal: req.signal } : {}),
    });
  }

  score(req: ScoreRequest): Promise<StructuredResult<{ score: number; rationale: string }>> {
    const ctx = { text: req.text, rubric: req.rubric };
    return this.generateStructured({
      messages: renderPrompt(scorePrompt, ctx),
      schema: scorePrompt.schema,
      schemaName: scorePrompt.schemaName,
      temperature: scorePrompt.temperature,
      maxOutputTokens: scorePrompt.maxOutputTokens,
      promptKey: scorePrompt.key,
      mockContext: ctx,
      ...(req.signal ? { signal: req.signal } : {}),
    });
  }
}

/** DeepSeek — default production LLM (cheap, OpenAI-compatible, JSON mode, context caching). */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(opts: { apiKey: string | undefined; baseUrl: string; model: string }) {
    super({
      name: "deepseek",
      baseUrl: opts.baseUrl.replace(/\/$/, ""),
      apiKey: opts.apiKey,
      defaultModel: opts.model,
      pricingProvider: "deepseek",
      supportsJsonMode: true,
      timeoutMs: 120_000,
    });
  }

  /** Uses the free balance endpoint — verifies the key without spending tokens. */
  override async healthCheck(): Promise<LlmHealth> {
    if (!this.opts.apiKey)
      return { ok: false, provider: this.name, isMock: false, message: "DEEPSEEK_API_KEY not configured" };
    const started = Date.now();
    try {
      const res = await fetch(`${this.opts.baseUrl}/user/balance`, {
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, provider: this.name, isMock: false, message: `HTTP ${res.status}` };
      const data = (await res.json()) as {
        is_available?: boolean;
        balance_infos?: { currency: string; total_balance: string }[];
      };
      const balance =
        data.balance_infos?.map((b) => `${b.total_balance} ${b.currency}`).join(", ") ?? "unknown";
      return {
        ok: data.is_available !== false,
        provider: this.name,
        isMock: false,
        latencyMs: Date.now() - started,
        message: `balance: ${balance}`,
      };
    } catch (err) {
      return { ok: false, provider: this.name, isMock: false, message: (err as Error).message };
    }
  }
}
