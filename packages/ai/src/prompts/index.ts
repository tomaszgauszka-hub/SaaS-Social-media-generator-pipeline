import { platformCaptionsPrompt } from "./caption/platform.ts";
import { hookVariantsPrompt } from "./hooks/variants.ts";
import { textReviewPrompt } from "./qa/text-review.ts";
import { classifyPrompt, scorePrompt } from "./scoring/generic.ts";
import { shortVideoScriptPrompt } from "./script/short-video.ts";
import { ideasPrompt, researchPrompt } from "./strategy/ideas.ts";

export * from "./contexts.ts";
export * from "./format.ts";
export * from "./registry.ts";
export * from "./schemas.ts";
export {
  classifyPrompt,
  hookVariantsPrompt,
  ideasPrompt,
  platformCaptionsPrompt,
  researchPrompt,
  scorePrompt,
  shortVideoScriptPrompt,
  textReviewPrompt,
};

/** Every prompt in the system (synced into the PromptVersion table). */
export const ALL_PROMPTS = [
  ideasPrompt,
  researchPrompt,
  shortVideoScriptPrompt,
  hookVariantsPrompt,
  platformCaptionsPrompt,
  textReviewPrompt,
  classifyPrompt,
  scorePrompt,
] as const;
