import type { ResearchBriefOutput } from "./schemas.ts";

/**
 * Structured contexts the pipeline builds for each prompt. Prompts turn them into template variables; the
 * mock LLM reads them directly to produce realistic, schema-valid output without any API call.
 */
export interface BrandPromptContext {
  name: string;
  niche: string;
  targetAudience: string;
  toneOfVoice: string;
  language: string;
  countries: string[];
  contentRules: string[];
  bannedWords: string[];
  ctaStyles: string[];
  complianceNotes: string | null;
  monetizationModels: string[];
}

export interface ProductFactContext {
  id: string;
  claim: string;
  source: string;
}

export interface ProductPromptContext {
  id: string;
  title: string;
  kind: string;
  manufacturer: string | null;
  category: string | null;
  description: string | null;
  /** verified, fresh price text (e.g. "$89.00") or null when the price must not be mentioned */
  priceText: string | null;
  commissionText: string;
  tags: string[];
  facts: ProductFactContext[];
  economicOutcome: string;
}

export interface IdeasContext {
  brand: BrandPromptContext;
  products: ProductPromptContext[];
  count: number;
  formats: string[];
  performanceSummary: string;
  avoidTitles: string[];
}

export interface IdeaPromptContext {
  title: string;
  /** a ContentAngle value for generated ideas; free text for manual ideas */
  angle: string;
  hook: string | null;
}

export interface ResearchContext {
  brand: BrandPromptContext;
  product: ProductPromptContext;
  idea: IdeaPromptContext;
}

export interface ScriptContext {
  brand: BrandPromptContext;
  product: ProductPromptContext;
  idea: IdeaPromptContext;
  research: ResearchBriefOutput;
  targetDurationSec: number;
  performanceSummary: string;
  economicOutcome: string;
  avoidHooks: string[];
  /** reviewer feedback from rejections / regeneration requests */
  feedback: string | null;
}

export interface HooksContext {
  brand: BrandPromptContext;
  product: ProductPromptContext;
  angle: string;
  currentHook: string;
  count: number;
  performanceSummary: string;
  avoidHooks: string[];
  feedback: string | null;
}

export interface CaptionsContext {
  brand: BrandPromptContext;
  product: ProductPromptContext;
  hook: string;
  cta: string;
  masterCaption: string;
  hashtags: string[];
  platforms: {
    platform: "INSTAGRAM" | "FACEBOOK" | "TIKTOK";
    maxChars: number;
    maxHashtags: number;
    linkClickable: boolean;
  }[];
}

export interface QaContext {
  brand: BrandPromptContext;
  product: ProductPromptContext;
  hook: string;
  onScreenTexts: string[];
  voiceover: string;
  caption: string;
}

export interface ClassifyContext {
  text: string;
  labels: readonly string[];
  instructions: string;
}

export interface ScoreContext {
  text: string;
  rubric: string;
}
