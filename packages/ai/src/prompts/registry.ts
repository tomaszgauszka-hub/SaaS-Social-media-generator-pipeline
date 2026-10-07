import { sha256Hex, ValidationError } from "@cre/shared";
import type { ZodType } from "zod";
import { jsonSchemaText, schemaInstruction } from "../structured.ts";
import type { LlmMessage } from "../types.ts";

/**
 * Versioned prompt templates. A prompt is identified by (key, version); its content hash is stored in the
 * PromptVersion table and every generation records which version produced it. Editing a template REQUIRES a
 * version bump — the prompt hash snapshot test fails otherwise.
 */
export interface PromptDefinition<Ctx, Out> {
  key: string;
  version: number;
  description: string;
  system: string;
  /** user message with {{variable}} placeholders */
  template: string;
  schemaName: string;
  schema: ZodType<Out>;
  temperature: number;
  maxOutputTokens: number;
  /** maps the structured context to template variables */
  toVars: (ctx: Ctx) => Record<string, string | number>;
}

export interface RegisteredPrompt<Ctx, Out> extends PromptDefinition<Ctx, Out> {
  contentHash: string;
  id: string;
}

export function definePrompt<Ctx, Out>(def: PromptDefinition<Ctx, Out>): RegisteredPrompt<Ctx, Out> {
  const contentHash = sha256Hex(
    JSON.stringify([
      def.key,
      def.version,
      def.system,
      def.template,
      def.schemaName,
      jsonSchemaText(def.schema),
    ]),
  );
  return { ...def, contentHash, id: `${def.key}@v${def.version}` };
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(PLACEHOLDER, (_, name: string) => {
    if (!(name in vars)) throw new ValidationError(`Missing prompt variable "${name}"`);
    return String(vars[name]);
  });
}

/** Render system + user messages (with the JSON schema contract appended to the user message). */
export function renderPrompt<Ctx, Out>(prompt: RegisteredPrompt<Ctx, Out>, ctx: Ctx): LlmMessage[] {
  const vars = prompt.toVars(ctx);
  return [
    { role: "system", content: renderTemplate(prompt.system, vars) },
    {
      role: "user",
      content: `${renderTemplate(prompt.template, vars)}\n\n${schemaInstruction(prompt.schemaName, prompt.schema)}`,
    },
  ];
}

/** Bulleted list helper for prompt variables. */
export function bullets(items: readonly string[], empty = "(none)"): string {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : empty;
}
