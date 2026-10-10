import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { HOOK_STRATEGIES, type HookStrategy } from "../contracts/ids.ts";
import type { ProductFact, ProductProfile } from "../contracts/product.ts";
import {
  HOOKS,
  factIdsFor,
  formatNumber,
  langOf,
  type CategoryKey,
  type Lang,
  type MatchedConcept,
} from "./lexicon.ts";

/**
 * Hook engine: which of the 12 strategies a product can honestly support, which one to use, and its native
 * line per language. A strategy that needs evidence (price, rating, performance, comparison) is excluded when
 * the facts do not contain it — the engine never invents a reason to buy.
 */

export interface HookContext {
  category: CategoryKey;
  profile: ProductProfile;
  facts: readonly ProductFact[];
  concepts: readonly MatchedConcept[];
  price?: { amount: number; currency: string; factId: string };
}

/**
 * A real customer rating: a "rating" fact, or a star / out-of-5 fact, with a value in (0, 5]. An energy rating, a
 * wattage or the word "review" in assembly instructions never is one.
 */
export function ratingFact(facts: readonly ProductFact[]): ProductFact | undefined {
  return facts.find(
    (f) =>
      f.value !== undefined &&
      f.value > 0 &&
      f.value <= 5 &&
      (f.kind === "rating" ||
        /\d(?:[.,]\d)?\s?(\/\s?5|out of 5|stars?\b|sterne|gwiazd\w*|estrellas|étoiles|stelle)/i.test(f.text)),
  );
}

export function hookApplicable(s: HookStrategy, c: HookContext): { ok: boolean; reason?: string } {
  const need = HOOKS[s].requires;
  switch (need) {
    case undefined:
      return { ok: true };
    case "price":
      return c.price ? { ok: true } : { ok: false, reason: "no price fact" };
    case "rating":
      return ratingFact(c.facts) ? { ok: true } : { ok: false, reason: "no customer rating fact" };
    case "performance":
      return c.facts.some((f) => f.kind === "performance" || f.kind === "power")
        ? { ok: true }
        : { ok: false, reason: "no performance fact" };
    case "comparison":
      return c.facts.some((f) => /\b(than|als|que|que|di|vs\.?)\b/i.test(f.text) && f.kind === "performance")
        ? { ok: true }
        : { ok: false, reason: "no comparative fact" };
    case "visual_contrast":
      return c.profile.traits.emitsLight ? { ok: true } : { ok: false, reason: "no visual before/after" };
    case "concept":
      return c.concepts.some((m) => m.concept.hook)
        ? { ok: true }
        : { ok: false, reason: "no hookable feature" };
  }
}

/** Default preference per category (first applicable wins unless history says otherwise). */
const PREFERENCE: Record<CategoryKey, HookStrategy[]> = {
  lighting: [
    "visual_surprise",
    "before_after",
    "feature_reveal",
    "problem_hook",
    "question",
    "benefit_first",
    "curiosity",
    "pain_point",
  ],
  tools: [
    "speed_demo",
    "problem_hook",
    "feature_reveal",
    "benefit_first",
    "pain_point",
    "question",
    "curiosity",
    "visual_surprise",
  ],
  electronics: [
    "feature_reveal",
    "visual_surprise",
    "benefit_first",
    "question",
    "curiosity",
    "problem_hook",
  ],
  beauty: ["before_after", "problem_hook", "benefit_first", "question", "curiosity", "visual_surprise"],
  home: ["benefit_first", "feature_reveal", "question", "visual_surprise", "curiosity", "problem_hook"],
  kitchen: ["speed_demo", "problem_hook", "benefit_first", "question", "visual_surprise", "curiosity"],
  fashion: ["visual_surprise", "feature_reveal", "question", "benefit_first", "curiosity"],
  other: ["benefit_first", "question", "visual_surprise", "curiosity", "feature_reveal", "problem_hook"],
};

export function applicableHooks(c: HookContext): HookStrategy[] {
  return HOOK_STRATEGIES.filter((s) => hookApplicable(s, c).ok);
}

/**
 * Pick a strategy: a forced one (A/B arm) if applicable; else the best stored performer for this
 * category / platform / locale with ≥ 3 measured reels; else the category preference.
 */
export function chooseHook(
  c: HookContext,
  opts: { forced?: HookStrategy; history?: { hookStrategy: string; score: number; n?: number }[] } = {},
): HookStrategy {
  const ok = new Set(applicableHooks(c));
  if (opts.forced && ok.has(opts.forced)) return opts.forced;
  const proven = (opts.history ?? [])
    .filter((h) => ok.has(h.hookStrategy as HookStrategy) && (h.n ?? 3) >= 3)
    .sort((a, b) => b.score - a.score)[0];
  if (proven) return proven.hookStrategy as HookStrategy;
  return PREFERENCE[c.category].find((s) => ok.has(s)) ?? "question";
}

/** The hook line in a language, with the facts it relies on. */
export function hookLine(
  s: HookStrategy,
  locale: string,
  c: HookContext,
): { text: string; factIds: string[] } {
  const lang: Lang = langOf(locale) ?? "en";
  const t = HOOKS[s];
  if (t.requires === "concept") {
    const m = (s === "feature_reveal" ? [...c.concepts].reverse() : c.concepts).find((x) => x.concept.hook);
    if (m?.concept.hook)
      return { text: m.concept.hook[lang], factIds: factIdsFor(m.factIds, c.facts, locale) };
    return hookLine("question", locale, c);
  }
  let text = (t.byCategory?.[c.category] ?? t.generic)[lang];
  const factIds: string[] = [];
  if (text.includes("{price}") && c.price) {
    text = text.replace("{price}", `${formatNumber(c.price.amount, lang)} ${c.price.currency}`);
    factIds.push(c.price.factId);
  }
  if (text.includes("{rating}")) {
    const f = ratingFact(c.facts);
    if (!f) return hookLine("question", locale, c);
    text = text.replace("{rating}", formatNumber(f.value!, lang));
    factIds.push(f.id);
  }
  if (s === "speed_demo") {
    const f = c.facts.find((x) => x.kind === "performance" || x.kind === "power");
    if (f) factIds.push(f.id);
  }
  return { text, factIds };
}

/* ---------------------------------------------------------------- memory ----------------------- */

export interface HookRecord {
  at: string;
  strategy: HookStrategy;
  category: string;
  platform: string;
  locale: string;
  productId: string;
  variantId: string;
  /** filled later from real platform analytics (views, completion, CTR, conversions …) */
  metrics?: { completionRate?: number; ctr?: number; conversionRate?: number; views?: number };
}

/**
 * Append-only JSONL of hooks used and (later) their real outcomes. There is no self-"learning" without data:
 * `bestFor` only ranks strategies that have measured outcomes.
 */
export class HookMemory {
  private readonly file: string;

  constructor(cacheDir: string) {
    this.file = path.join(cacheDir, "hooks", "memory.jsonl");
  }

  async record(r: HookRecord): Promise<void> {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.appendFile(this.file, `${JSON.stringify(r)}\n`);
  }

  all(): HookRecord[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as HookRecord];
        } catch {
          return [];
        }
      });
  }

  /** score = mean of (completion · 0.5 + CTR · 30 + conversion · 100) over measured reels */
  bestFor(
    category: string,
    platform: string,
    locale: string,
  ): { hookStrategy: string; score: number; n: number }[] {
    const lang = locale.slice(0, 2);
    const rows = this.all().filter(
      (r) => r.metrics && r.category === category && r.platform === platform && r.locale.startsWith(lang),
    );
    const by = new Map<string, number[]>();
    for (const r of rows) {
      const m = r.metrics!;
      const s = (m.completionRate ?? 0) * 0.5 + (m.ctr ?? 0) * 30 + (m.conversionRate ?? 0) * 100;
      by.set(r.strategy, [...(by.get(r.strategy) ?? []), s]);
    }
    return [...by.entries()]
      .map(([hookStrategy, xs]) => ({
        hookStrategy,
        score: xs.reduce((a, b) => a + b, 0) / xs.length,
        n: xs.length,
      }))
      .sort((a, b) => b.score - a.score);
  }
}

/* ---------------------------------------------------------------- cheap A/B ---------------------- */

const ensureStop = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);

/**
 * A/B arm without a new render: the same plan (shots, music, SFX, timing) with another hook strategy — only the
 * on-screen hook and the spoken hook line change, so the arm reuses the master video and the audio bed.
 * Returns null when the strategy cannot be supported by the product's facts.
 */
export function rehookPlan<
  P extends {
    metadata: { planId: string; variantKey: string; seed: string; hookStrategy: HookStrategy };
    language: string;
    copy: { locale: string; slots: Record<string, { kind: string; text: string; factIds: string[] }> };
  },
>(plan: P, strategy: HookStrategy, variantKey: string, c: HookContext): P | null {
  if (!hookApplicable(strategy, c).ok) return null;
  const h = hookLine(strategy, plan.copy.locale, c);
  const slots = { ...plan.copy.slots };
  if (slots.hook) slots.hook = { ...slots.hook, text: h.text, factIds: h.factIds };
  for (const id of Object.keys(slots))
    if (/^voice\.\d+\.hook$/.test(id))
      slots[id] = { ...slots[id]!, text: ensureStop(h.text), factIds: h.factIds };
  return {
    ...plan,
    metadata: {
      ...plan.metadata,
      planId: plan.metadata.planId.replace(/-[A-Z]$/, `-${variantKey}`),
      variantKey,
      seed: plan.metadata.seed.replace(/:[A-Z]$/, `:${variantKey}`),
      hookStrategy: strategy,
    },
    copy: { ...plan.copy, slots },
  };
}
