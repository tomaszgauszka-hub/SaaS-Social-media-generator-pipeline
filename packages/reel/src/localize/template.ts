import type { CallContext, TranscreationProvider, TranscreationRequest } from "../capabilities/types.ts";
import type { HookStrategy } from "../contracts/ids.ts";
import { LocaleCopy, type CopySlot } from "../contracts/plan.ts";
import type { ProductFact } from "../contracts/product.ts";
import { hookLine, type HookContext } from "../director/hooks.ts";
import {
  CONCEPTS,
  CTA_BUTTON,
  CTA_TEXT,
  CTA_VOICE,
  DESIRE,
  DISCLOSURE,
  detectConcepts,
  factIdsFor,
  langOf,
  type CategoryKey,
  type Lang,
} from "../director/lexicon.ts";

/**
 * Template transcreation (local): every master slot is re-written natively from the same lexicon — not
 * translated word by word. Slot ids carry a stable tag (the lexicon concept or the sales role), so the target
 * line expresses the same claim with the same facts (preferring the facts written in the target language).
 * A slot the lexicon cannot express in the target language is dropped and reported, never left untranslated.
 */

export const TEMPLATE_TRANSCREATION_VERSION = "template-transcreation/1";

const ensureStop = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);

export function transcreateSlots(
  req: TranscreationRequest,
  target: { locale: string; market: string },
): { slots: Record<string, CopySlot>; dropped: string[] } {
  const lang: Lang = langOf(target.locale) ?? "en";
  const category = (req.product.category as CategoryKey) || "other";
  const facts = (req.sourceFacts ?? req.facts) as ProductFact[];
  const matched = detectConcepts(facts, category);
  const ctx: HookContext = { category, profile: req.product, facts, concepts: matched };
  const slots: Record<string, CopySlot> = {};
  const dropped: string[] = [];
  const concept = (tag: string) => {
    const c = CONCEPTS.find((x) => x.id === tag);
    const m = matched.find((x) => x.concept.id === tag);
    return c && m ? { c, ids: factIdsFor(m.factIds, facts, target.locale) } : null;
  };
  for (const [id, s] of Object.entries(req.master.slots)) {
    const tag = id.split(".").slice(2).join(".") || id.split(".")[1] || "";
    const strategy = (req.hookStrategy ?? "question") as HookStrategy;
    switch (s.kind) {
      case "hook": {
        const h = hookLine(strategy, target.locale, ctx);
        slots[id] = { kind: "hook", text: h.text, factIds: h.factIds };
        break;
      }
      case "voice":
      case "overlay":
      case "caption": {
        const k = concept(tag);
        if (k)
          slots[id] = {
            kind: s.kind,
            text: s.kind === "overlay" ? k.c.short[lang] : k.c.line[lang],
            factIds: k.ids,
          };
        else if (tag === "hook") {
          const h = hookLine(strategy, target.locale, ctx);
          slots[id] = { kind: s.kind, text: ensureStop(h.text), factIds: h.factIds };
        } else if (tag === "cta") slots[id] = { kind: s.kind, text: CTA_VOICE[lang], factIds: [] };
        else if ((tag === "desire" || tag === "value") && s.factIds.length === 0)
          slots[id] = {
            kind: s.kind,
            text: DESIRE[category === "lighting" || category === "tools" ? category : "generic"][lang],
            factIds: [],
          };
        else dropped.push(id);
        break;
      }
      case "cta":
        slots[id] = {
          kind: "cta",
          text: (
            req.brand.preferredCTA[target.locale]?.[0] ??
            req.brand.preferredCTA[lang]?.[0] ??
            CTA_TEXT[lang]
          ).slice(0, 48),
          factIds: [],
        };
        break;
      case "button":
        slots[id] = { kind: "button", text: CTA_BUTTON[lang], factIds: [] };
        break;
      case "disclosure":
        slots[id] = {
          kind: "disclosure",
          text: req.brand.disclosure[target.locale] ?? req.brand.disclosure[lang] ?? DISCLOSURE[lang],
          factIds: [],
        };
        break;
    }
  }
  return { slots, dropped };
}

export class TemplateTranscreation implements TranscreationProvider {
  readonly name = "template";
  readonly capability = "transcreation" as const;
  readonly local = true;
  readonly model = TEMPLATE_TRANSCREATION_VERSION;

  available(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }

  estimateMicros(): number {
    return 0;
  }

  transcreate(req: TranscreationRequest, ctx: CallContext): Promise<LocaleCopy[]> {
    const out = req.targets.map((t) => {
      if (!langOf(t.locale))
        ctx.logger?.warn({ locale: t.locale }, "no native templates for this language — using English");
      const { slots, dropped } = transcreateSlots(req, t);
      if (dropped.length)
        ctx.logger?.warn({ locale: t.locale, dropped }, "slots without a native template were dropped");
      return LocaleCopy.parse({
        locale: t.locale,
        market: t.market,
        slots,
        transcreation: {
          provider: this.name,
          model: this.model,
          sourceLocale: req.master.locale,
          isMaster: false,
        },
      });
    });
    return Promise.resolve(out);
  }
}
