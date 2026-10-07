import { extractJson, FatalError } from "@cre/shared";
import { z, type ZodType } from "zod";
import type {
  GenerateTextRequest,
  LlmCallResult,
  LlmMessage,
  StructuredRequest,
  StructuredResult,
} from "./types.ts";

export class StructuredOutputError extends FatalError {
  readonly calls: LlmCallResult[];

  constructor(message: string, calls: LlmCallResult[], details?: Record<string, unknown>) {
    super(message, { code: "STRUCTURED_OUTPUT_INVALID", ...(details ? { details } : {}) });
    this.calls = calls;
  }
}

const schemaCache = new WeakMap<object, string>();

/** JSON Schema text for a Zod schema (embedded in prompts so the model knows the exact shape). */
export function jsonSchemaText(schema: ZodType): string {
  const cached = schemaCache.get(schema);
  if (cached) return cached;
  const text = JSON.stringify(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
  schemaCache.set(schema, text);
  return text;
}

export function schemaInstruction(schemaName: string, schema: ZodType): string {
  return [
    `Return ONLY a single JSON object (no markdown, no commentary) named ${schemaName} that validates against this JSON Schema:`,
    jsonSchemaText(schema),
  ].join("\n");
}

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 15)
    .map((i) => `- ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("\n");
}

/**
 * Structured generation loop shared by all providers:
 *   call → extract JSON → validate with Zod → on failure, send the errors back and ask for a corrected object.
 * Truncated outputs (finish_reason "length") get a larger token budget on the next attempt.
 */
export async function runStructured<T>(
  call: (req: GenerateTextRequest) => Promise<LlmCallResult>,
  req: StructuredRequest<T>,
): Promise<StructuredResult<T>> {
  const maxAttempts = 1 + (req.maxRepairAttempts ?? 2);
  const calls: LlmCallResult[] = [];
  const messages: LlmMessage[] = [...req.messages];
  let maxOutputTokens = req.maxOutputTokens ?? 2000;
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await call({
      ...req,
      messages,
      jsonMode: true,
      maxOutputTokens,
    });
    calls.push(result);

    let parsed: unknown;
    try {
      parsed = extractJson(result.text);
    } catch (err) {
      lastError = `Output was not valid JSON (${(err as Error).message}).`;
      if (result.finishReason === "length") maxOutputTokens = Math.round(maxOutputTokens * 1.6);
      messages.push(
        { role: "assistant", content: result.text.slice(0, 4000) },
        { role: "user", content: `${lastError} Return the complete JSON object only.` },
      );
      continue;
    }

    const validated = req.schema.safeParse(parsed);
    if (validated.success) return { data: validated.data, calls, attempts: attempt };

    lastError = formatZodIssues(validated.error);
    messages.push(
      { role: "assistant", content: result.text.slice(0, 6000) },
      {
        role: "user",
        content: `The JSON does not match the ${req.schemaName} schema:\n${lastError}\nFix these problems and return the full corrected JSON object only.`,
      },
    );
  }
  throw new StructuredOutputError(
    `LLM output for ${req.schemaName} invalid after ${maxAttempts} attempts: ${lastError.slice(0, 500)}`,
    calls,
    { schemaName: req.schemaName, promptKey: req.promptKey },
  );
}
