import type { GoogleAI } from "@cre/providers";
import { z } from "zod";
import type { CallContext, DirectorInput, DirectorProvider } from "../capabilities/types.ts";
import { DirectorDecision } from "../contracts/plan.ts";
import { recordCall, recordFailure, thinkingFor } from "../providers/google/common.ts";

/**
 * Gemini director: a cheap multimodal Flash(-Lite) model decides WHAT the reel is — hook, sales structure, shot
 * presets, voice lines, music intent — as a small JSON object constrained by the DirectorDecision schema (only
 * whitelisted ids and bounded numbers can come back). The prompt is minimal: the product profile, facts by id,
 * brand / platform essentials. No repository, no history dumps. One repair round, then the chain falls back.
 */

export const GEMINI_DIRECTOR_PROMPT_VERSION = "gemini-director/1";

const SYSTEM = `You are the director of short vertical SALES videos (9:16) for real products.
Plan a reel that makes the viewer want to buy: HOOK (first 1.5 s, stop the scroll) → PROBLEM/NEED or BENEFIT →
PROOF/FEATURE (show the real product doing / being it) → DESIRE → CTA. Compress to the requested duration
(e.g. 12 s: hook 0-1.5, benefit 1.5-4, demo/proof 4-8, strongest value 8-10, CTA 10-12). 3-6 shots.
RULES:
- Write every text in the requested language, natively (no translationese), short: hook ≤ 60 chars,
  overlays ≤ 7 words, voice lines spoken in ≤ 3 s each, CTA ≤ 4 words, button ≤ 3 words.
- Claims ONLY from the given facts; cite their ids in factIds. No invented numbers, prices, discounts,
  warranties, certificates, reviews, ratings or features. Never claim anything listed under "risks".
- Emotional lines without product claims are fine (factIds empty). No superlatives (best, #1, cheapest).
- Never use the brand's forbidden phrases. Prefer the brand's CTA lines.
- The product is shown from its real 3D model: choose shot presets that show it well (its traits and
  visual opportunities); do not depict things the product does not have.
- Seconds of all shots must add up to durationS.`;

export function directorPayload(input: DirectorInput): string {
  const lang = input.locale.slice(0, 2);
  const facts = input.facts.filter(
    (f) => !/^bp\./.test(f.id) || f.id.includes(`.${lang}-`) || f.id.includes(".en-"),
  );
  return JSON.stringify({
    language: input.locale,
    market: input.market,
    durationS: input.targetDurationS,
    objective: input.objective,
    product: {
      name: input.product.shortName,
      category: input.product.category,
      traits: input.product.traits,
      visual_features: input.product.visual_features,
      selling_points: input.product.selling_points,
      visual_opportunities: input.product.visual_opportunities,
      risks: input.product.risks,
      likely_customer: input.product.likely_customer,
    },
    facts: facts.map((f) => [f.id, f.kind, f.text.slice(0, 220)]),
    ...(input.price ? { price: input.price } : {}),
    brand: {
      name: input.brand.brandName,
      voice: input.brand.voicePersona.description,
      environment: input.brand.visualStyle.environment,
      energy: input.brand.visualStyle.energy,
      music: input.brand.musicStyle,
      forbidden: input.brand.forbiddenPhrases.slice(0, 40),
      cta: input.brand.preferredCTA[input.locale] ?? [],
    },
    platform: input.platform,
    reusable_assets: input.assets.slice(0, 8),
    hook_history: input.history.slice(0, 6),
    ...(input.hookStrategy ? { required_hook_strategy: input.hookStrategy } : {}),
  });
}

/** Post-schema checks a JSON schema cannot express. */
export function decisionProblems(d: DirectorDecision, input: DirectorInput): string[] {
  const known = new Set(input.facts.map((f) => f.id));
  if (input.price) known.add(input.price.factId);
  const problems: string[] = [];
  const cite = (where: string, ids: string[]) => {
    const bad = ids.filter((id) => !known.has(id));
    if (bad.length) problems.push(`${where} cites unknown fact ids ${bad.join(", ")}`);
  };
  cite("hook", d.hook.factIds);
  d.voiceover.lines.forEach((l, i) => cite(`voice line ${i + 1}`, l.factIds));
  d.shots.forEach((s, i) => s.overlay && cite(`shot ${i + 1} overlay`, s.overlay.factIds));
  cite("cta", d.cta.factIds);
  const sum = d.shots.reduce((a, s) => a + s.seconds, 0);
  if (Math.abs(sum - d.durationS) > 0.6)
    problems.push(`shot seconds add up to ${sum.toFixed(1)}, durationS is ${d.durationS}`);
  if (d.shots[d.shots.length - 1]?.role !== "CTA") problems.push("the last shot must have role CTA");
  if (input.hookStrategy && d.hook.strategy !== input.hookStrategy)
    problems.push(`hook.strategy must be ${input.hookStrategy}`);
  for (const p of input.brand.forbiddenPhrases) {
    const all = [d.hook.text, d.cta.text, ...d.voiceover.lines.map((l) => l.text)].join(" ").toLowerCase();
    if (p && all.includes(p.toLowerCase())) problems.push(`forbidden phrase "${p}"`);
  }
  return problems;
}

export class GeminiDirector implements DirectorProvider {
  readonly capability = "director" as const;
  readonly local = false;

  constructor(
    private readonly ai: GoogleAI,
    readonly model: string,
    readonly name = "gemini",
  ) {}

  available(): Promise<{ ok: boolean; reason?: string }> {
    return Promise.resolve(
      this.ai.hasApiKey ? { ok: true } : { ok: false, reason: "GOOGLE_API_KEY not set" },
    );
  }

  estimateMicros(input: DirectorInput): number {
    // prompt + schema + payload in, ~900 tokens out; ×1.5 for the possible repair round
    const inTokens = 1900 + Math.ceil(directorPayload(input).length / 3.2);
    return Math.round(this.ai.estimateGenerateMicros(this.model, inTokens, 900) * 1.5);
  }

  async direct(
    input: DirectorInput,
    ctx: CallContext,
  ): Promise<{ decision: DirectorDecision; promptVersion: string }> {
    const schema = z.toJSONSchema(DirectorDecision, { io: "input" });
    const payload = directorPayload(input);
    let feedback = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      let res;
      try {
        res = await this.ai.generate({
          model: this.model,
          system: SYSTEM,
          parts: [{ text: payload }, ...(feedback ? [{ text: feedback }] : [])],
          jsonSchema: schema,
          thinkingLevel: thinkingFor(this.model),
          maxOutputTokens: 1600,
          timeoutMs: 45_000,
          label: "reel.director",
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      } catch (e) {
        recordFailure(ctx, "director", this.model, e);
        throw e;
      }
      recordCall(ctx, {
        capability: "director",
        model: res.model,
        costMicros: res.costMicros,
        estimated: res.costEstimated,
        usage: res.usage,
        latencyMs: res.latencyMs,
        note: `${GEMINI_DIRECTOR_PROMPT_VERSION} attempt ${attempt}`,
      });
      const parsed = DirectorDecision.safeParse(res.json ?? safeJson(res.text));
      const problems = parsed.success
        ? decisionProblems(parsed.data, input)
        : parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`);
      if (parsed.success && !problems.length)
        return { decision: parsed.data, promptVersion: GEMINI_DIRECTOR_PROMPT_VERSION };
      feedback = `Your previous answer was rejected. Fix exactly these problems and answer again:\n- ${problems.join("\n- ")}`;
    }
    throw new Error(`gemini director: decision rejected after repair — ${feedback.slice(0, 300)}`);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
