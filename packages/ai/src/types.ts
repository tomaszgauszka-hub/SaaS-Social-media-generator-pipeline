import type { Micros } from "@cre/shared";
import type { ZodType } from "zod";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface LlmCallResult {
  text: string;
  usage: LlmUsage;
  provider: string;
  model: string;
  latencyMs: number;
  finishReason?: string;
  /** real cost when the API reports it */
  actualCostMicros?: Micros;
  isMock: boolean;
}

export interface GenerateTextRequest {
  messages: LlmMessage[];
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** prompt key (used by the mock provider to pick a generator, and for logging) */
  promptKey?: string;
  /** structured context the prompt was rendered from — only the mock provider reads it */
  mockContext?: unknown;
}

export interface StructuredRequest<T> extends Omit<GenerateTextRequest, "jsonMode"> {
  schema: ZodType<T>;
  schemaName: string;
  /** additional attempts that feed validation errors back to the model */
  maxRepairAttempts?: number;
}

export interface StructuredResult<T> {
  data: T;
  calls: LlmCallResult[];
  attempts: number;
}

export interface LlmCostEstimateRequest {
  model?: string;
  inputTokens: number;
  maxOutputTokens: number;
  /** number of calls to reserve for (structured output repairs) */
  calls?: number;
}

export interface LlmCostEstimate {
  provider: string;
  model: string;
  estimatedMicros: Micros;
  isMock: boolean;
}

export interface LlmHealth {
  ok: boolean;
  provider: string;
  isMock: boolean;
  message?: string;
  latencyMs?: number;
}

export interface ClassifyRequest {
  text: string;
  labels: readonly string[];
  instructions?: string;
  signal?: AbortSignal;
}

export interface ScoreRequest {
  text: string;
  rubric: string;
  signal?: AbortSignal;
}

/**
 * LLM provider contract. DeepSeek is the default implementation; any OpenAI-compatible API works through the
 * same base class. Other vendors (Anthropic, Gemini) can implement this interface directly.
 */
export interface LLMProvider {
  readonly name: string;
  readonly isMock: boolean;
  readonly defaultModel: string;
  healthCheck(): Promise<LlmHealth>;
  estimateCost(req: LlmCostEstimateRequest): LlmCostEstimate;
  /** single completion (= execute) */
  generateText(req: GenerateTextRequest): Promise<LlmCallResult>;
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
  classify(req: ClassifyRequest): Promise<StructuredResult<{ label: string; confidence: number }>>;
  score(req: ScoreRequest): Promise<StructuredResult<{ score: number; rationale: string }>>;
}
