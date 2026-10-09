import type { GoogleAI } from "@cre/providers";
import { z } from "zod";
import type { CallContext, TranscreationProvider, TranscreationRequest } from "../capabilities/types.ts";
import { LocaleCopy, type CopySlot } from "../contracts/plan.ts";
import { recordCall, recordFailure, thinkingFor } from "../providers/google/common.ts";

/**
 * Gemini transcreation: ONE call adapts the master copy to every target market (marketing adaptation, not
 * word-for-word). Slot ids and kinds are fixed by code; the model only returns text + the fact ids it relies on,
 * within per-slot character limits. Claim validation runs afterwards (factory); on failure the chain falls back
 * to the template transcreation.
 */

export const GEMINI_TRANSCREATION_PROMPT_VERSION = "gemini-transcreation/1";

const Answer = z.object({
  locales: z.array(
    z.object({
      locale: z.string(),
      slots: z.array(
        z.object({ id: z.string(), text: z.string().min(1).max(200), factIds: z.array(z.string()).max(6) }),
      ),
    }),
  ),
});

const SYSTEM = `You transcreate the on-screen and spoken copy of a short product sales video into other markets.
Write like a native copywriter of each market: idiomatic, punchy, natural to read aloud; adapt idioms and CTA
conventions instead of translating word for word. Keep the meaning and every product claim; add no new claim,
number, price, promotion, warranty or feature. Respect each slot's character limit. Keep the slot ids.
Use the product name as it is used in that market (given) and never use forbidden phrases.`;

export class GeminiTranscreation implements TranscreationProvider {
  readonly name = "gemini";
  readonly capability = "transcreation" as const;
  readonly local = false;

  constructor(
    private readonly ai: GoogleAI,
    readonly model: string,
  ) {}

  available(): Promise<{ ok: boolean; reason?: string }> {
    return Promise.resolve(
      this.ai.hasApiKey ? { ok: true } : { ok: false, reason: "GOOGLE_API_KEY not set" },
    );
  }

  estimateMicros(req: TranscreationRequest): number {
    const chars = Object.values(req.master.slots).reduce((s, x) => s + x.text.length, 0);
    const inTokens = 700 + Math.ceil((chars + req.facts.length * 80) / 3.2);
    return this.ai.estimateGenerateMicros(
      this.model,
      inTokens,
      Math.ceil((chars * req.targets.length) / 2.5) + 200,
    );
  }

  async transcreate(req: TranscreationRequest, ctx: CallContext): Promise<LocaleCopy[]> {
    const payload = JSON.stringify({
      source_language: req.master.locale,
      targets: req.targets,
      product_names: req.productNames,
      brand: {
        name: req.brand.brandName,
        forbidden: req.brand.forbiddenPhrases.slice(0, 40),
        cta: req.brand.preferredCTA,
      },
      facts: req.facts.map((f) => [f.id, f.kind, f.text.slice(0, 200)]),
      slots: Object.entries(req.master.slots).map(([id, s]) => ({
        id,
        kind: s.kind,
        text: s.text,
        factIds: s.factIds,
        maxChars: req.limits[id] ?? 80,
      })),
    });
    let res;
    try {
      res = await this.ai.generate({
        model: this.model,
        system: SYSTEM,
        parts: [{ text: payload }],
        jsonSchema: z.toJSONSchema(Answer),
        thinkingLevel: thinkingFor(this.model),
        maxOutputTokens: 2500,
        timeoutMs: 45_000,
        label: "reel.transcreation",
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (e) {
      recordFailure(ctx, "transcreation", this.model, e);
      throw e;
    }
    recordCall(ctx, {
      capability: "transcreation",
      model: res.model,
      costMicros: res.costMicros,
      estimated: res.costEstimated,
      usage: res.usage,
      latencyMs: res.latencyMs,
      note: GEMINI_TRANSCREATION_PROMPT_VERSION,
    });
    const answer = Answer.parse(res.json ?? JSON.parse(res.text));
    return req.targets.map((t) => {
      const got = answer.locales.find((l) => l.locale === t.locale);
      if (!got) throw new Error(`transcreation: ${t.locale} missing in the answer`);
      const slots: Record<string, CopySlot> = {};
      for (const [id, master] of Object.entries(req.master.slots)) {
        const s = got.slots.find((x) => x.id === id);
        if (!s) throw new Error(`transcreation: ${t.locale} slot ${id} missing`);
        const limit = req.limits[id] ?? 200;
        if (s.text.length > limit) throw new Error(`transcreation: ${t.locale} ${id} longer than ${limit}`);
        // fact ids may only narrow to facts that exist; the slot kind never changes
        slots[id] = {
          kind: master.kind,
          text: s.text.trim(),
          factIds: s.factIds.filter((f) => req.facts.some((x) => x.id === f)),
        };
      }
      return LocaleCopy.parse({
        locale: t.locale,
        market: t.market,
        slots,
        transcreation: {
          provider: this.name,
          model: res.model,
          sourceLocale: req.master.locale,
          isMaster: false,
        },
      });
    });
  }
}
