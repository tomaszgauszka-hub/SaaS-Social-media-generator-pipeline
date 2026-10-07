/** JSON-compatible value (what Prisma `Json` columns accept). */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * Convert arbitrary data (Dates, undefined, class instances) to a plain JSON value suitable for a Json column.
 * Round-trips through JSON so the stored value equals what will be read back.
 */
export function toJson<T>(value: T): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** Extract the first JSON object/array from LLM output (tolerates ```json fences and leading prose). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fence?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    if (start === -1) throw new SyntaxError("No JSON object found in model output");
    const open = candidate[start];
    const close = open === "{" ? "}" : "]";
    const end = candidate.lastIndexOf(close);
    if (end <= start) throw new SyntaxError("Unterminated JSON in model output");
    return JSON.parse(candidate.slice(start, end + 1));
  }
}
