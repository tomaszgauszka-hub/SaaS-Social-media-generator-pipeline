import type { ClassifyContext, ScoreContext } from "../contexts.ts";
import { definePrompt } from "../registry.ts";
import { ClassificationOutput, ScoreOutput } from "../schemas.ts";

export const classifyPrompt = definePrompt<ClassifyContext, { label: string; confidence: number }>({
  key: "scoring.classify",
  version: 1,
  description: "Classify a text into one of a fixed set of labels",
  system: "You are a precise classifier. Answer with exactly one of the allowed labels.",
  template: `{{instructions}}

Allowed labels: {{labels}}

Text:
"""
{{text}}
"""`,
  schemaName: "ClassificationOutput",
  schema: ClassificationOutput,
  temperature: 0,
  maxOutputTokens: 200,
  toVars: (ctx) => ({ instructions: ctx.instructions, labels: ctx.labels.join(", "), text: ctx.text }),
});

export const scorePrompt = definePrompt<ScoreContext, { score: number; rationale: string }>({
  key: "scoring.score",
  version: 1,
  description: "Score a text 0-100 against a rubric",
  system: "You are a demanding reviewer. Score honestly; most content is average (40-70).",
  template: `Rubric:
{{rubric}}

Text:
"""
{{text}}
"""`,
  schemaName: "ScoreOutput",
  schema: ScoreOutput,
  temperature: 0,
  maxOutputTokens: 400,
  toVars: (ctx) => ({ rubric: ctx.rubric, text: ctx.text }),
});
