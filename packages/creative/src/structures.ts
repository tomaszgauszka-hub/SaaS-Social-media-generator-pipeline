import type { BeatPurpose, CreativeStructure } from "./model.ts";

/**
 * Commercial creative structures (spec §23) as ordered beat recipes. The director walks the recipe, builds each
 * beat from the brief, and skips steps the brief has no material for (then tops up to the minimum beat count).
 */
export type RecipeStep =
  | "HOOK"
  | "PROBLEM"
  | "SOLUTION"
  | "HERO"
  | "MACRO"
  | "CALLOUTS"
  | "STAT"
  | "SPECS"
  | "CHECKLIST"
  | "IN_USE"
  | "BEFORE_AFTER"
  | "SIDE_BY_SIDE"
  | "SCREEN"
  | "STEPS"
  | "RECAP"
  | "CTA";

export interface StructureRecipe {
  structure: CreativeStructure;
  description: string;
  steps: RecipeStep[];
  /** purposes the finished storyboard must contain to tell the story */
  required: BeatPurpose[];
}

export const STRUCTURES: Record<CreativeStructure, StructureRecipe> = {
  PRODUCT_HERO: {
    structure: "PRODUCT_HERO",
    description: "Lead with the product, then prove it with details and use",
    steps: ["HOOK", "HERO", "MACRO", "STAT", "CALLOUTS", "IN_USE", "CTA"],
    required: ["HOOK", "PRODUCT", "FEATURE", "CTA"],
  },
  PROBLEM_SOLUTION: {
    structure: "PROBLEM_SOLUTION",
    description: "Show the everyday problem, reveal the product as the fix, prove it, before/after",
    steps: ["PROBLEM", "SOLUTION", "HERO", "STAT", "STEPS", "IN_USE", "BEFORE_AFTER", "CTA"],
    required: ["PROBLEM", "SOLUTION", "PRODUCT", "CTA"],
  },
  BEFORE_AFTER: {
    structure: "BEFORE_AFTER",
    description: "Mess first, product in action, measurable benefit, the transformation",
    steps: ["HOOK", "HERO", "IN_USE", "STAT", "CALLOUTS", "STEPS", "BEFORE_AFTER", "CTA"],
    required: ["HOOK", "PRODUCT", "COMPARISON", "CTA"],
  },
  TOP_3_FEATURES: {
    structure: "TOP_3_FEATURES",
    description: "Three strongest features, each with its own visual proof",
    steps: ["HOOK", "HERO", "MACRO", "STAT", "MACRO", "IN_USE", "CTA"],
    required: ["HOOK", "PRODUCT", "FEATURE", "CTA"],
  },
  THREE_THINGS_TO_KNOW: {
    structure: "THREE_THINGS_TO_KNOW",
    description: "Numbered: three things worth knowing before you buy",
    steps: ["HOOK", "HERO", "MACRO", "STAT", "MACRO", "BEFORE_AFTER", "RECAP", "CTA"],
    required: ["HOOK", "PRODUCT", "FEATURE", "CTA"],
  },
  SPEC_BREAKDOWN: {
    structure: "SPEC_BREAKDOWN",
    description: "Specs that matter, shown on the product, then the kit",
    steps: ["HOOK", "HERO", "MACRO", "STAT", "MACRO", "IN_USE", "SPECS", "CTA"],
    required: ["HOOK", "PRODUCT", "SPEC", "CTA"],
  },
  PRODUCT_DEMO: {
    structure: "PRODUCT_DEMO",
    description: "Problem, product, every capability demonstrated, clean result",
    steps: ["HOOK", "HERO", "CALLOUTS", "SCREEN", "STAT", "MACRO", "SIDE_BY_SIDE", "CTA"],
    required: ["HOOK", "PRODUCT", "DEMO", "CTA"],
  },
  COMPARISON: {
    structure: "COMPARISON",
    description: "This versus the usual alternative",
    steps: ["HOOK", "SIDE_BY_SIDE", "CALLOUTS", "STAT", "SPECS", "CTA"],
    required: ["HOOK", "COMPARISON", "CTA"],
  },
  HOW_TO: {
    structure: "HOW_TO",
    description: "Step by step, then the result",
    steps: ["HOOK", "HERO", "STEPS", "IN_USE", "BEFORE_AFTER", "CTA"],
    required: ["HOOK", "STEP", "CTA"],
  },
  MYTH_VS_FACT: {
    structure: "MYTH_VS_FACT",
    description: "Common belief, the fact, the proof",
    steps: ["PROBLEM", "SOLUTION", "HERO", "STAT", "CALLOUTS", "CTA"],
    required: ["PROBLEM", "SOLUTION", "CTA"],
  },
  BUYING_GUIDE: {
    structure: "BUYING_GUIDE",
    description: "What to check before buying — and a product that ticks the boxes",
    steps: ["HOOK", "CHECKLIST", "HERO", "CALLOUTS", "STAT", "CTA"],
    required: ["HOOK", "PROOF", "PRODUCT", "CTA"],
  },
  SAAS_UI_DEMO: {
    structure: "SAAS_UI_DEMO",
    description: "Screen-first walkthrough of the workflow",
    steps: ["HOOK", "SCREEN", "STAT", "CHECKLIST", "CTA"],
    required: ["HOOK", "DEMO", "CTA"],
  },
  TEST_RESULT: {
    structure: "TEST_RESULT",
    description: "Set up a test, run it, show the measured result",
    steps: ["HOOK", "HERO", "IN_USE", "STAT", "CALLOUTS", "BEFORE_AFTER", "CTA"],
    required: ["HOOK", "DEMO", "PROOF", "CTA"],
  },
  QUESTION_HOOK: {
    structure: "QUESTION_HOOK",
    description: "Open with the viewer's question, answer it visually",
    steps: ["HOOK", "HERO", "MACRO", "STAT", "IN_USE", "CTA"],
    required: ["HOOK", "PRODUCT", "CTA"],
  },
  CONTRARIAN_HOOK: {
    structure: "CONTRARIAN_HOOK",
    description: "Challenge an assumption, then back it up",
    steps: ["HOOK", "HERO", "STAT", "MACRO", "IN_USE", "CTA"],
    required: ["HOOK", "PRODUCT", "PROOF", "CTA"],
  },
};

/** Steps used to top up a storyboard that came out too short. */
export const FILLER_STEPS: RecipeStep[] = ["CALLOUTS", "MACRO", "STAT", "IN_USE", "SPECS", "CHECKLIST"];

export const MIN_BEATS = 6;
export const MAX_BEATS = 10;
