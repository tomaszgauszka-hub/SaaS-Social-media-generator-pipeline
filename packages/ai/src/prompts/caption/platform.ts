import type { CaptionsContext } from "../contexts.ts";
import { brandHeader, factsBlock, rulesBlock } from "../format.ts";
import { bullets, definePrompt } from "../registry.ts";
import { PlatformCaptionsOutput } from "../schemas.ts";

export const platformCaptionsPrompt = definePrompt<CaptionsContext, PlatformCaptionsOutput>({
  key: "caption.platform",
  version: 1,
  description: "Adapt one master caption to each platform's length, tone and link behaviour",
  system: `You adapt social media captions for "{{brandName}}" to each platform without changing the facts.
Brand voice: {{tone}}

{{rules}}`,
  template: `Adapt the master caption for each platform below.
- Keep the meaning and only the sourced facts. Never add claims.
- Respect each platform's character and hashtag limits.
- Where links are NOT clickable, point people to the link in bio; where they are clickable, say "tap the link".
- Do NOT add the advertising disclosure or the link itself — both are inserted automatically.

PLATFORMS
{{platforms}}

HOOK: {{hook}}
CTA: {{cta}}
MASTER CAPTION:
{{caption}}
MASTER HASHTAGS: {{hashtags}}

PRODUCT FACTS
{{facts}}`,
  schemaName: "PlatformCaptionsOutput",
  schema: PlatformCaptionsOutput,
  temperature: 0.6,
  maxOutputTokens: 1800,
  toVars: (ctx) => ({
    ...brandHeader(ctx.brand),
    rules: rulesBlock(ctx.brand),
    platforms: bullets(
      ctx.platforms.map(
        (p) =>
          `${p.platform}: max ${p.maxChars} characters, max ${p.maxHashtags} hashtags, links ${p.linkClickable ? "ARE" : "are NOT"} clickable`,
      ),
    ),
    hook: ctx.hook,
    cta: ctx.cta,
    caption: ctx.masterCaption,
    hashtags: ctx.hashtags.join(" ") || "(none)",
    facts: factsBlock(ctx.product),
  }),
});
