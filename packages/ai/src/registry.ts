import { resolveModelCatalog, resolveProviderSelection, type Env } from "@cre/config";
import { estimateTokens } from "@cre/shared";
import { renderPrompt, type RegisteredPrompt } from "./prompts/registry.ts";
import { MockLLMProvider, type MockLlmOptions } from "./providers/mock.ts";
import { DeepSeekProvider, OpenAICompatibleProvider } from "./providers/openai-compatible.ts";
import type { LlmCallResult, LlmCostEstimate, LLMProvider } from "./types.ts";

/** Configuration-driven LLM provider construction (DeepSeek by default, mock in MOCK_AI mode). */
export function createLlmProvider(env: Env, mockOverrides: Partial<MockLlmOptions> = {}): LLMProvider {
  const selection = resolveProviderSelection(env);
  const models = resolveModelCatalog(env, selection);
  switch (selection.llm) {
    case "mock":
      return new MockLLMProvider({ costMode: env.MOCK_COST_MODE, ...mockOverrides });
    case "deepseek":
      return new DeepSeekProvider({
        apiKey: env.DEEPSEEK_API_KEY,
        baseUrl: env.DEEPSEEK_BASE_URL,
        model: models.llm.default,
      });
    case "openai":
      return new OpenAICompatibleProvider({
        name: "openai",
        baseUrl: env.OPENAI_BASE_URL,
        apiKey: env.OPENAI_API_KEY,
        defaultModel: models.llm.default,
        pricingProvider: "openai",
        supportsJsonMode: true,
      });
  }
}

export interface PromptRun<Out> {
  data: Out;
  calls: LlmCallResult[];
  attempts: number;
  promptId: string;
}

/** Estimate the cost of running a prompt (reserve for the initial call + repair attempts). */
export function estimatePromptCost<Ctx, Out>(
  llm: LLMProvider,
  prompt: RegisteredPrompt<Ctx, Out>,
  ctx: Ctx,
  maxRepairAttempts = 1,
): LlmCostEstimate {
  const messages = renderPrompt(prompt, ctx);
  const inputTokens = estimateTokens(messages.map((m) => m.content).join("\n"));
  return llm.estimateCost({
    inputTokens,
    maxOutputTokens: prompt.maxOutputTokens,
    calls: 1 + maxRepairAttempts,
  });
}

/** Render a versioned prompt with its context and run it as structured generation. */
export async function runPrompt<Ctx, Out>(
  llm: LLMProvider,
  prompt: RegisteredPrompt<Ctx, Out>,
  ctx: Ctx,
  opts: { signal?: AbortSignal; maxRepairAttempts?: number; model?: string } = {},
): Promise<PromptRun<Out>> {
  const result = await llm.generateStructured<Out>({
    messages: renderPrompt(prompt, ctx),
    schema: prompt.schema,
    schemaName: prompt.schemaName,
    temperature: prompt.temperature,
    maxOutputTokens: prompt.maxOutputTokens,
    maxRepairAttempts: opts.maxRepairAttempts ?? 1,
    promptKey: prompt.key,
    mockContext: ctx,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return { ...result, promptId: prompt.id };
}

/** Sum token usage across calls (structured repairs make several calls). */
export function sumUsage(calls: LlmCallResult[]): {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
} {
  return calls.reduce(
    (acc, c) => ({
      inputTokens: acc.inputTokens + c.usage.inputTokens,
      outputTokens: acc.outputTokens + c.usage.outputTokens,
      cachedInputTokens: acc.cachedInputTokens + c.usage.cachedInputTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  );
}
