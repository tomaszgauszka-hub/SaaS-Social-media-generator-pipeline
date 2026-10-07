import type { QaContext } from "../contexts.ts";
import { brandHeader, factsBlock } from "../format.ts";
import { bullets, definePrompt } from "../registry.ts";
import { QaReviewOutput } from "../schemas.ts";

export const textReviewPrompt = definePrompt<QaContext, QaReviewOutput>({
  key: "qa.text_review",
  version: 1,
  description: "Strict copy + compliance review of generated text against sourced facts",
  system: `You are a strict copy editor and advertising-compliance reviewer for "{{brandName}}".
You check generated social media content BEFORE a human sees it. Be precise and conservative: when in doubt, flag it.`,
  template: `Review the content below.

Report:
- spelling / grammar mistakes (language: {{language}})
- unsupported_claim: any claim, number, spec, price, comparison or superlative NOT supported by the product facts
- contradiction: statements that conflict with each other or with the facts (e.g. two different prices)
- compliance: fake testimonials or personal experiences, medical/financial claims, fake urgency, banned words
- tone: off-brand language (brand voice: {{tone}})
- clarity: confusing or truncated sentences
Ignore the advertising disclosure and links (handled elsewhere).
severity: blocker = must not be published; major = should be fixed; minor = nice to fix.
score: 100 = flawless; deduct for every issue.

PRODUCT FACTS (the only allowed claims)
{{facts}}

BANNED WORDS: {{banned}}
CONTENT RULES
{{rules}}

CONTENT
hook: {{hook}}
on-screen text:
{{onScreen}}
voice-over: {{voiceover}}
caption:
{{caption}}`,
  schemaName: "QaReviewOutput",
  schema: QaReviewOutput,
  temperature: 0.1,
  maxOutputTokens: 1500,
  toVars: (ctx) => ({
    ...brandHeader(ctx.brand),
    facts: factsBlock(ctx.product),
    banned: ctx.brand.bannedWords.join(", ") || "(none)",
    rules: bullets(ctx.brand.contentRules),
    hook: ctx.hook,
    onScreen: bullets(ctx.onScreenTexts),
    voiceover: ctx.voiceover || "(none)",
    caption: ctx.caption,
  }),
});
