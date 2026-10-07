import { llmCostMicros, MOCK_SIMULATES } from "@cre/config";
import { estimateTokens, ProviderError, sleep, TimeoutError } from "@cre/shared";
import { MOCK_GENERATORS } from "../mock/generators.ts";
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

export type MockFailure = "malformed" | "invalid_schema" | "timeout" | "rate_limit";

export interface MockLlmOptions {
  costMode: "simulate" | "zero";
  /** artificial latency per call */
  latencyMs?: number;
  /** scripted failures per prompt key, consumed in order (tests) */
  failures?: Record<string, MockFailure[]>;
}

/**
 * Mock LLM (MOCK_AI=true). No network. Token counts are estimated from the prompt/output text and valued at
 * DeepSeek prices in "simulate" mode, so cost accounting and budgets behave like production.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = "mock";
  readonly isMock = true;
  readonly defaultModel = `mock:${MOCK_SIMULATES.llm.model}`;
  private readonly failures: Record<string, MockFailure[]>;
  /** number of calls served (tests assert on it) */
  callCount = 0;

  constructor(private readonly opts: MockLlmOptions) {
    this.failures = structuredClone(opts.failures ?? {});
  }

  healthCheck(): Promise<LlmHealth> {
    return Promise.resolve({
      ok: true,
      provider: this.name,
      isMock: true,
      message: "mock LLM (no API calls)",
    });
  }

  estimateCost(req: LlmCostEstimateRequest): LlmCostEstimate {
    const perCall =
      this.opts.costMode === "zero"
        ? 0
        : llmCostMicros(MOCK_SIMULATES.llm.provider, MOCK_SIMULATES.llm.model, {
            inputTokens: req.inputTokens,
            outputTokens: req.maxOutputTokens,
          });
    return {
      provider: this.name,
      model: this.defaultModel,
      estimatedMicros: perCall * (req.calls ?? 1),
      isMock: true,
    };
  }

  async generateText(req: GenerateTextRequest): Promise<LlmCallResult> {
    this.callCount++;
    const started = Date.now();
    if (this.opts.latencyMs) await sleep(this.opts.latencyMs, req.signal);
    const key = req.promptKey ?? "unknown";
    const failure = this.failures[key]?.shift();
    if (failure === "timeout") throw new TimeoutError(`mock LLM timeout for ${key}`);
    if (failure === "rate_limit") throw new ProviderError("mock", "rate limited", { status: 429 });

    const generator = MOCK_GENERATORS[key];
    let text: string;
    if (failure === "malformed") {
      text = '{"this is": not valid json';
    } else if (failure === "invalid_schema") {
      text = JSON.stringify({ unexpected: true });
    } else if (generator && req.mockContext !== undefined) {
      text = JSON.stringify(generator(req.mockContext as never));
    } else {
      text = JSON.stringify({ text: "mock response" });
    }

    const inputTokens = estimateTokens(req.messages.map((m) => m.content).join("\n"));
    const outputTokens = estimateTokens(text);
    return {
      text,
      usage: { inputTokens, outputTokens, cachedInputTokens: 0 },
      provider: this.name,
      model: this.defaultModel,
      latencyMs: Date.now() - started,
      finishReason: "stop",
      isMock: true,
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
      promptKey: classifyPrompt.key,
      mockContext: ctx,
    });
  }

  score(req: ScoreRequest): Promise<StructuredResult<{ score: number; rationale: string }>> {
    const ctx = { text: req.text, rubric: req.rubric };
    return this.generateStructured({
      messages: renderPrompt(scorePrompt, ctx),
      schema: scorePrompt.schema,
      schemaName: scorePrompt.schemaName,
      promptKey: scorePrompt.key,
      mockContext: ctx,
    });
  }
}
