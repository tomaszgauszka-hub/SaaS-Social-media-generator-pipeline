import type { CallContext, DirectorInput, DirectorProvider } from "../capabilities/types.ts";
import type {
  HookStrategy,
  ProductAnimation,
  SalesRole,
  SfxKind,
  ShotPreset,
  Transition,
} from "../contracts/ids.ts";
import { DirectorDecision, type DirectorShot } from "../contracts/plan.ts";
import type { ProductFact } from "../contracts/product.ts";
import { chooseHook, hookLine, type HookContext } from "./hooks.ts";
import {
  AND,
  CTA_BUTTON,
  CTA_TEXT,
  CTA_VOICE,
  DESIRE,
  MADE_OF,
  MATERIAL_WORDS,
  detectConcepts,
  factIdsFor,
  langOf,
  type CategoryKey,
  type Lang,
  type MatchedConcept,
} from "./lexicon.ts";

/**
 * Deterministic director: a sales-first decision from the product profile, the facts and a per-category shot
 * grammar — HOOK → BENEFIT → PROOF → DESIRE → CTA (compressed or extended to the duration). Copy comes from the
 * native lexicon; claims only from fact-matched concepts. Same input → same decision. It is the last link of the
 * director chain, so a reel never depends on an API.
 */

export const TEMPLATE_DIRECTOR_VERSION = "template-director/1";

interface Beat {
  role: SalesRole;
  preset: ShotPreset;
  share: number;
  animation?: ProductAnimation;
  focus?: DirectorShot["focus"];
  transition: Transition;
  sfx?: { kind: SfxKind; at: "start" | "mid" | "end" };
}

/** shot grammars: role order, preset, share of the duration */
function grammar(category: CategoryKey, emitsLight: boolean, hook: HookStrategy, seconds: number): Beat[] {
  const lighting = category === "lighting" || emitsLight;
  const beats: Beat[] = lighting
    ? [
        {
          role: "HOOK",
          preset: hook === "before_after" ? "hero_reveal" : "silhouette_reveal",
          share: 0.17,
          animation: "light_on",
          transition: "cut",
          sfx: { kind: "light_switch", at: "mid" },
        },
        {
          role: "BENEFIT",
          preset: "slow_turntable",
          share: 0.25,
          transition: "fade",
          sfx: { kind: "whoosh", at: "start" },
        },
        {
          role: "PROOF",
          preset: "macro_push",
          share: 0.2,
          focus: "middle",
          transition: "fade",
          sfx: { kind: "shimmer", at: "start" },
        },
        {
          role: "DESIRE",
          preset: "camera_slide",
          share: 0.17,
          transition: "smoothleft",
          sfx: { kind: "whoosh", at: "start" },
        },
        {
          role: "CTA",
          preset: "cta_hero",
          share: 0.21,
          transition: "fade",
          sfx: { kind: "bass_hit", at: "start" },
        },
      ]
    : category === "tools" || category === "kitchen" || category === "electronics"
      ? [
          {
            role: "HOOK",
            preset: "impact",
            share: 0.17,
            transition: "cut",
            sfx: { kind: "impact", at: "start" },
          },
          {
            role: "DEMO",
            preset: "turntable",
            share: 0.25,
            transition: "slideleft",
            sfx: { kind: "whoosh", at: "start" },
          },
          {
            role: "PROOF",
            preset: "detail_closeup",
            share: 0.2,
            focus: "detail",
            transition: "fade",
            sfx: { kind: "mechanical_click", at: "mid" },
          },
          {
            role: "VALUE",
            preset: "feature_highlight",
            share: 0.17,
            transition: "wipeleft",
            sfx: { kind: "transition", at: "start" },
          },
          {
            role: "CTA",
            preset: "cta_hero",
            share: 0.21,
            transition: "fade",
            sfx: { kind: "bass_hit", at: "start" },
          },
        ]
      : [
          {
            role: "HOOK",
            preset: "hero_reveal",
            share: 0.17,
            transition: "cut",
            sfx: { kind: "riser", at: "start" },
          },
          {
            role: "BENEFIT",
            preset: "turntable",
            share: 0.25,
            transition: "fade",
            sfx: { kind: "whoosh", at: "start" },
          },
          {
            role: "PROOF",
            preset: "detail_closeup",
            share: 0.2,
            focus: "detail",
            transition: "fade",
            sfx: { kind: "shimmer", at: "start" },
          },
          {
            role: "DESIRE",
            preset: "orbit",
            share: 0.17,
            transition: "smoothleft",
            sfx: { kind: "whoosh", at: "start" },
          },
          {
            role: "CTA",
            preset: "cta_hero",
            share: 0.21,
            transition: "fade",
            sfx: { kind: "bass_hit", at: "start" },
          },
        ];
  // short reels drop DESIRE; long reels add a VALUE close-up before the CTA
  if (seconds < 9) return beats.filter((b) => b.role !== "DESIRE" && b.role !== "VALUE");
  if (seconds > 16)
    beats.splice(beats.length - 1, 0, {
      role: "VALUE",
      preset: "low_angle",
      share: 0.15,
      transition: "fade",
    });
  return beats;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const ensureStop = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);

/** Material list concept for products without a richer material concept ("Metal+Wood+Fabric"). */
function materialsLine(
  facts: readonly ProductFact[],
  lang: Lang,
): { line: string; short: string; factIds: string[] } | null {
  const f = facts.find((x) => x.kind === "material" && /\+|,|\//.test(x.text) && x.locale === "en-US");
  if (!f) return null;
  const words = f.text
    .toLowerCase()
    .split(/[+,/]| and /)
    .map((w) => w.trim().replace(/aluminium/, "aluminum"))
    .map((w) => MATERIAL_WORDS[w]?.[lang])
    .filter((w): w is string => Boolean(w));
  if (words.length < 2) return null;
  const list = `${words.slice(0, -1).join(", ")} ${AND[lang]} ${words[words.length - 1]}`;
  return { line: MADE_OF[lang](list), short: words.join(" · "), factIds: [f.id] };
}

export interface CopyPick {
  text: string;
  factIds: string[];
  /** lexicon concept id (stable across languages) or null for emotional / CTA lines */
  conceptId: string | null;
}

/** The claim content per role, in priority order (lamp-specific concepts first). */
const ROLE_CONCEPTS: Partial<Record<SalesRole, string[]>> = {
  BENEFIT: [
    "materials_walnut_brass_fabric",
    "ceramic_nickel_linen",
    "marble_brass",
    "resin_metal_linen",
    "mid_century_style",
    "room_standout",
    "led_bulb_included",
  ],
  PROOF: [
    "curved_brass_stem",
    "geometric_cutouts",
    "wood_grain_finish",
    "marble_brass",
    "led_work_light",
    "keyless_chuck",
    "mid_century_style",
    "materials_walnut_brass_fabric",
    "easy_assembly",
  ],
  DESIRE: ["led_bulb_included", "room_standout", "easy_assembly"],
  VALUE: [
    "carry_case",
    "charger_included",
    "battery_included",
    "room_standout",
    "easy_assembly",
    "led_bulb_included",
  ],
  DEMO: ["battery_included", "keyless_chuck", "easy_assembly", "materials_walnut_brass_fabric"],
};

/** The role's preferred unused concept; any unused one unless `strict` (role-specific only). */
export function pickConcept(
  role: SalesRole,
  matched: readonly MatchedConcept[],
  used: Set<string>,
  opts: { strict?: boolean } = {},
): MatchedConcept | undefined {
  const order = ROLE_CONCEPTS[role] ?? [];
  return (
    order.map((id) => matched.find((m) => m.concept.id === id)).find((m) => m && !used.has(m.concept.id)) ??
    (opts.strict ? undefined : matched.find((m) => !used.has(m.concept.id)))
  );
}

export class TemplateDirector implements DirectorProvider {
  readonly name = "template";
  readonly capability = "director" as const;
  readonly local = true;
  readonly model = TEMPLATE_DIRECTOR_VERSION;

  available(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }

  estimateMicros(): number {
    return 0;
  }

  direct(
    input: DirectorInput,
    ctx: CallContext,
  ): Promise<{ decision: DirectorDecision; promptVersion: string }> {
    const t0 = Date.now();
    const decision = templateDecision(input);
    ctx.tracker.compute({
      stage: "other",
      label: "template director",
      wallMs: Date.now() - t0,
      scope: ctx.scope,
    });
    return Promise.resolve({ decision, promptVersion: TEMPLATE_DIRECTOR_VERSION });
  }
}

export function templateDecision(input: DirectorInput): DirectorDecision {
  const lang: Lang = langOf(input.locale) ?? "en";
  const category = (input.product.category as CategoryKey) || "other";
  const facts = input.facts as ProductFact[];
  const matched = detectConcepts(facts, category);
  const hookCtx: HookContext = {
    category,
    profile: input.product,
    facts,
    concepts: matched,
    ...(input.price ? { price: input.price } : {}),
  };
  const strategy = chooseHook(hookCtx, {
    ...(input.hookStrategy ? { forced: input.hookStrategy as HookStrategy } : {}),
    history: input.history,
  });
  const seconds = Math.min(
    input.platform.durationMs.max / 1000,
    Math.max(input.platform.durationMs.min / 1000, input.targetDurationS),
  );
  const beats = grammar(category, input.product.traits.emitsLight, strategy, seconds);
  const total = beats.reduce((s, b) => s + b.share, 0);
  const hook = hookLine(strategy, input.locale, hookCtx);
  const used = new Set<string>();
  const generic = materialsLine(facts, lang);
  // the proof close-up needs a part the camera can show (a concept with a focus): reserve it first, so the
  // benefit line does not use up the product's only visual detail (a marble lamp's marble cube)
  let reserved = beats.some((b) => b.role === "PROOF")
    ? pickConcept(
        "PROOF",
        matched.filter((m) => m.concept.focus && m.concept.focus !== "whole"),
        used,
      )
    : undefined;
  if (reserved) used.add(reserved.concept.id);

  const voice: DirectorDecision["voiceover"]["lines"] = [];
  const shots: DirectorShot[] = beats.map((b, i) => {
    const shot: DirectorShot = {
      role: b.role,
      preset: b.preset,
      seconds: Math.round((b.share / total) * seconds * 100) / 100,
      productAnimation: b.animation ?? "none",
      focus: b.focus ?? "whole",
      transition: i === 0 ? "cut" : b.transition,
    };
    switch (b.role) {
      case "HOOK":
        voice.push({ role: "HOOK", text: ensureStop(hook.text), factIds: hook.factIds });
        break;
      case "BENEFIT":
      case "DEMO": {
        // a role-specific concept, else the proof's own detail (the voice names what the close-up will show),
        // else the materials line, else whatever the facts still support
        const m =
          pickConcept(b.role, matched, used, { strict: true }) ??
          reserved ??
          (generic ? undefined : pickConcept(b.role, matched, used));
        if (m) {
          used.add(m.concept.id);
          voice.push({
            role: b.role,
            text: m.concept.line[lang],
            factIds: factIdsFor(m.factIds, facts, input.locale),
          });
        } else if (generic) voice.push({ role: b.role, text: generic.line, factIds: generic.factIds });
        break;
      }
      case "PROOF":
      case "VALUE": {
        const m = b.role === "PROOF" && reserved ? reserved : pickConcept(b.role, matched, used);
        if (b.role === "PROOF") reserved = undefined;
        if (m) {
          used.add(m.concept.id);
          shot.overlay = { text: m.concept.short[lang], factIds: factIdsFor(m.factIds, facts, input.locale) };
          // the claim decides what the camera looks at (the beat's focus is only the default)
          if (m.concept.focus && b.preset !== "cta_hero") shot.focus = m.concept.focus;
        }
        break;
      }
      case "DESIRE": {
        voice.push({
          role: "DESIRE",
          text: DESIRE[category === "lighting" || category === "tools" ? category : "generic"][lang],
          factIds: [],
        });
        const m = pickConcept("DESIRE", matched, used);
        if (m) {
          used.add(m.concept.id);
          shot.overlay = { text: m.concept.short[lang], factIds: factIdsFor(m.factIds, facts, input.locale) };
        }
        break;
      }
      case "CTA":
        voice.push({ role: "CTA", text: CTA_VOICE[lang], factIds: [] });
        break;
      case "PROBLEM":
        break;
    }
    return shot;
  });

  const [bpmLo, bpmHi] = input.brand.musicStyle.bpm;
  const bpm = Math.max(70, Math.min(150, Math.round((bpmLo + bpmHi) / 2)));
  let t = 0;
  const starts = shots.map((s) => {
    const at = t;
    t += s.seconds;
    return at;
  });
  const ctaAt = starts[starts.length - 1] ?? seconds - 2;
  const energy = input.brand.visualStyle.energy;
  const preferred = input.brand.preferredCTA[input.locale]?.[0] ?? input.brand.preferredCTA[lang]?.[0];
  return DirectorDecision.parse({
    objective: input.objective,
    durationS: seconds,
    targetAudience: input.product.likely_customer[0] ?? "online shoppers",
    hook: { strategy, text: hook.text, factIds: hook.factIds },
    visualStyle: {
      environment: input.brand.visualStyle.environment,
      energy,
      lighting: category === "lighting" ? "warm_practical" : "three_point",
    },
    shots,
    voiceover: { enabled: true, lines: voice.slice(0, 6), pace: 1 },
    music: {
      genre: input.brand.musicStyle.genres[0],
      mood: input.brand.musicStyle.moods[0],
      bpm,
      energyCurve: [
        { atS: 0, energy: r2(Math.max(0.2, energy - 0.25)) },
        { atS: r2(starts[1] ?? 2), energy: r2(Math.min(1, energy + 0.05)) },
        { atS: r2(ctaAt), energy: r2(Math.min(1, energy + 0.3)) },
      ],
      finalHitAtS: Math.round(ctaAt * 100) / 100,
    },
    sfx: beats.flatMap((b, i) => (b.sfx ? [{ shotIndex: i, kind: b.sfx.kind, at: b.sfx.at }] : [])),
    // the brand's caption preset is applied by the plan compiler
    captions: { style: "word_highlight" },
    cta: { text: (preferred ?? CTA_TEXT[lang]).slice(0, 48), buttonText: CTA_BUTTON[lang], factIds: [] },
  });
}
