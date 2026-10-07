import { seededRandom, truncate } from "@cre/shared";
import type {
  CaptionsContext,
  ClassifyContext,
  HooksContext,
  IdeasContext,
  ProductPromptContext,
  QaContext,
  ResearchContext,
  ScoreContext,
  ScriptContext,
} from "../prompts/contexts.ts";
import type {
  ContentAngle,
  CtaType,
  HookStyle,
  HookVariantsOutput,
  IdeaOut,
  IdeasOutput,
  PlatformCaptionsOutput,
  QaReviewOutput,
  ResearchBriefOutput,
  ScriptOutput,
} from "../prompts/schemas.ts";

const FREE_WORD = /(?<![\p{L}\p{N}-])free(?![\p{L}\p{N}-])/iu;

/**
 * Deterministic "LLM" used in MOCK_AI mode. Produces realistic, schema-valid output from the same context the
 * real prompt is rendered from, using ONLY the product facts — so mock content still passes the real QA rules.
 */

export function shortName(title: string): string {
  const base = title.split(/ — | - |\(|,/)[0]!.trim();
  const words = base.split(/\s+/);
  return words.length > 4 ? words.slice(0, 4).join(" ") : base;
}

export function categoryNoun(p: ProductPromptContext): string {
  const fromCategory = p.category?.split("/").pop()?.replace(/-/g, " ").trim();
  if (fromCategory) {
    const singular =
      fromCategory.endsWith("s") && !fromCategory.endsWith("ss") ? fromCategory.slice(0, -1) : fromCategory;
    return singular.split(" ").pop() ?? singular;
  }
  return p.title.split(/\s+/).pop()?.toLowerCase() ?? "product";
}

function hookFor(angle: string, p: ProductPromptContext, variant = 0): { text: string; style: HookStyle } {
  const cat = categoryNoun(p);
  const name = shortName(p.title);
  const options: Record<string, { text: string; style: HookStyle }[]> = {
    problem_solution: [
      { text: `Stop settling for a weak *${cat}*`, style: "problem_solution" },
      { text: `Your *${cat}* is the problem`, style: "bold_claim" },
    ],
    before_you_buy: [
      { text: `Before you buy a *${cat}*, watch this`, style: "mistake_warning" },
      { text: `Buying a *${cat}*? Check these first`, style: "question" },
    ],
    spec_breakdown: [
      { text: `*3 specs* that actually matter`, style: "number_list" },
      { text: `What the *${name}* specs mean`, style: "curiosity_gap" },
    ],
    comparison: [
      { text: `*${name}* vs the cheap ones`, style: "comparison" },
      { text: `Is the *${name}* worth it?`, style: "question" },
    ],
    mistakes_to_avoid: [
      { text: `The *${cat}* mistake that costs you`, style: "mistake_warning" },
      { text: `Don't buy a *${cat}* like this`, style: "mistake_warning" },
    ],
    top_benefits: [
      { text: `*3 reasons* people pick this ${cat}`, style: "number_list" },
      { text: `Why the *${name}* stands out`, style: "curiosity_gap" },
    ],
    how_to_use: [
      { text: `Get more from your *${cat}*`, style: "how_to" },
      { text: `How to use a *${cat}* properly`, style: "how_to" },
    ],
    myth_busting: [
      { text: `Myth: a good *${cat}* costs a fortune`, style: "myth_busting" },
      { text: `You don't need a pricey *${cat}*`, style: "myth_busting" },
    ],
    deal_alert: [
      { text: `*${name}* at ${p.priceText ?? "a fair price"}`, style: "deal_alert" },
      { text: `Here's what *${p.priceText ?? "this"}* gets you`, style: "deal_alert" },
    ],
    use_case: [
      { text: `POV: the right *${cat}* for the job`, style: "pov" },
      { text: `When you finally get a proper *${cat}*`, style: "pov" },
    ],
  };
  const list = options[angle] ?? options.problem_solution!;
  return list[variant % list.length]!;
}

const ANGLES: ContentAngle[] = [
  "problem_solution",
  "before_you_buy",
  "spec_breakdown",
  "comparison",
  "mistakes_to_avoid",
  "top_benefits",
  "how_to_use",
  "myth_busting",
];

function stripMarks(s: string): string {
  return s.replace(/\*/g, "");
}

function shortFact(claim: string, maxWords = 8): string {
  const words = claim
    .replace(/\(.*?\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ");
  return words.length <= maxWords ? words.join(" ") : words.slice(0, maxWords).join(" ");
}

export function mockIdeas(ctx: IdeasContext): IdeasOutput {
  const avoid = new Set(ctx.avoidTitles.map((t) => t.toLowerCase()));
  // Every product × angle combination is a candidate. Unused combinations come first, then ones whose hook
  // was not used recently; repeats get a "(take N)" title and alternate hook wording, so a long-running brand
  // never runs out of (mock) ideas — QA still flags hooks that are too similar to recent ones.
  const candidates = ctx.products
    .flatMap((p) =>
      (p.priceText ? [...ANGLES, "deal_alert" as const] : ANGLES).map((angle) => ({ p, angle })),
    )
    .map(({ p, angle }) => {
      const base = `${shortName(p.title)}: ${angle.replace(/_/g, " ")}`;
      let take = 1;
      while (avoid.has((take === 1 ? base : `${base} (take ${take})`).toLowerCase())) take++;
      const hook = hookFor(angle, p, take - 1);
      return {
        p,
        angle,
        take,
        hook,
        title: take === 1 ? base : `${base} (take ${take})`,
        freshHook: !avoid.has(stripMarks(hook.text).toLowerCase()),
        order: seededRandom(`${p.id}:${angle}`)(),
      };
    })
    .sort((a, b) => a.take - b.take || Number(b.freshHook) - Number(a.freshHook) || a.order - b.order);

  const ideas: IdeaOut[] = [];
  for (const { p, angle, hook, title } of candidates.slice(0, ctx.count)) {
    const rnd = seededRandom(`${title}:${ideas.length}`);
    ideas.push({
      productId: p.id,
      title: truncate(title, 140),
      angle,
      format: "SHORT_VIDEO",
      economicOutcome: (["AFFILIATE_CLICK", "LEAD", "SALE", "SERVICE_INQUIRY", "EMAIL_SIGNUP"].includes(
        p.economicOutcome,
      )
        ? p.economicOutcome
        : "AFFILIATE_CLICK") as IdeaOut["economicOutcome"],
      hook: truncate(stripMarks(hook.text), 140),
      targetAudience: truncate(ctx.brand.targetAudience, 240),
      whyItConverts: truncate(
        `Shows a concrete reason to choose the ${shortName(p.title)} using sourced facts (${p.facts
          .slice(0, 2)
          .map((f) => f.id)
          .join(", ")}), aimed at viewers already shopping for a ${categoryNoun(p)}.`,
        400,
      ),
      riskNotes: p.facts.length < 2 ? "Few sourced facts — keep claims general." : "",
      hookStrength: 5 + Math.floor(rnd() * 5),
      purchaseIntent:
        angle === "before_you_buy" || angle === "comparison" || angle === "deal_alert"
          ? 8
          : 5 + Math.floor(rnd() * 4),
      confidence: Math.round((0.45 + rnd() * 0.3) * 100) / 100,
    });
  }
  return { ideas };
}

export function mockResearch(ctx: ResearchContext): ResearchBriefOutput {
  const p = ctx.product;
  const cat = categoryNoun(p);
  const facts = p.facts.length ? p.facts : [{ id: "none", claim: p.title, source: "title" }];
  return {
    positioning: truncate(
      `${shortName(p.title)} is a practical pick for ${ctx.brand.targetAudience.split(" who ")[0]?.toLowerCase() ?? "buyers"} who want a ${cat} that does the job without overpaying.`,
      400,
    ),
    keyBenefits: facts
      .slice(0, 4)
      .map((f) => ({ benefit: truncate(shortFact(f.claim, 12), 160), factId: f.id })),
    audiencePainPoints: [
      `Wasting money on a ${cat} that disappoints`,
      `Not knowing which ${cat} specs actually matter`,
      `Too many near-identical options to compare`,
    ],
    objections: [
      {
        objection: `Is it worth it compared to cheaper ${cat}s?`,
        answer: truncate(`Point to the sourced specs: ${shortFact(facts[0]!.claim, 10)}.`, 240),
        factId: facts[0]!.id,
      },
    ],
    forbiddenClaims: [
      `"Best ${cat} on the market"`,
      "Any durability, lifespan or performance claim not in the facts",
      ...ctx.brand.bannedWords.slice(0, 4).map((w) => `Anything using "${w}"`),
    ].slice(0, 10),
    complianceNotes: [
      "Disclose the affiliate relationship",
      "No personal-experience or testimonial language",
    ],
  };
}

function ctaTypeFor(cta: string): CtaType {
  const c = cta.toLowerCase();
  if (c.includes("comment")) return "comment_keyword";
  if (c.includes("save")) return "save_post";
  if (c.includes("dm")) return "dm_keyword";
  return "link_in_bio";
}

export function mockScript(ctx: ScriptContext): ScriptOutput {
  const p = ctx.product;
  const cat = categoryNoun(p);
  const name = shortName(p.title);
  const avoid = new Set(ctx.avoidHooks.map((h) => stripMarks(h).toLowerCase()));
  let hook = ctx.idea.hook
    ? { text: ctx.idea.hook, style: "problem_solution" as HookStyle }
    : hookFor(ctx.idea.angle, p, 0);
  for (let v = 0; v < 4 && avoid.has(stripMarks(hook.text).toLowerCase()); v++)
    hook = hookFor(ctx.idea.angle, p, v + 1);
  if (!hook.text.includes("*")) {
    const words = hook.text.split(" ");
    const idx = Math.min(words.length - 1, Math.max(0, words.length - 2));
    words[idx] = `*${words[idx]}*`;
    hook = { ...hook, text: words.join(" ") };
  }
  const facts = p.facts.length ? p.facts : [{ id: "none", claim: p.title, source: "title" }];
  const bulletsList = facts.slice(0, 3).map((f) => truncate(shortFact(f.claim, 8), 80));
  const pain = ctx.research.audiencePainPoints[0] ?? `Most ${cat}s cut corners`;
  const benefit = ctx.research.keyBenefits[0]?.benefit ?? shortFact(facts[0]!.claim);
  // like a careful copywriter: never promise "free" unless a fact supports it
  const freeOk = facts.some((f) => FREE_WORD.test(f.claim));
  const cta = ctx.brand.ctaStyles.find((c) => freeOk || !FREE_WORD.test(c)) ?? "Link in bio";
  const script: ScriptOutput["script"] = [
    { sceneKind: "HOOK", durationSec: 2.6, onScreenText: hook.text, voiceover: `${stripMarks(hook.text)}.` },
    { sceneKind: "PROBLEM", durationSec: 3.6, onScreenText: truncate(pain, 70), voiceover: `${pain}.` },
    {
      sceneKind: "PRODUCT",
      durationSec: 4.6,
      onScreenText: `Meet the *${name}*`,
      voiceover: truncate(`Meet the ${name}. ${ctx.research.positioning}`, 230),
    },
    { sceneKind: "AI_SHOT", durationSec: 3.6, onScreenText: truncate(benefit, 70), voiceover: `${benefit}.` },
    {
      sceneKind: "BENEFITS",
      durationSec: 5.2,
      onScreenText: "What you get",
      voiceover: truncate(`Here is what you get: ${bulletsList.join(", ")}.`, 400),
      bullets: bulletsList,
    },
    { sceneKind: "CTA", durationSec: 3.8, onScreenText: truncate(cta, 60), voiceover: `${cta}.` },
  ];
  const scene = (i: number) => i;
  const visualPlan: ScriptOutput["visualPlan"] = [
    {
      sceneIndex: scene(0),
      type: "generated_image",
      description: `Relatable ${cat} frustration moment`,
      imagePrompt: `Vertical 9:16 photo, close-up of a frustrating everyday ${cat} situation in a ${ctx.brand.niche} setting, natural light, shallow depth of field, no text, no logos, no product`,
      motion: "zoom_in",
    },
    {
      sceneIndex: scene(1),
      type: "generated_image",
      description: `Context scene for the problem`,
      imagePrompt: `Vertical 9:16 lifestyle photo of a ${ctx.brand.niche} workspace, moody light, cinematic, no text, no logos, no product`,
      motion: "kenburns",
    },
    { sceneIndex: scene(2), type: "product_image", description: `Real product photo of the ${name}` },
    {
      sceneIndex: scene(3),
      type: "ai_video",
      description: "Short cinematic push-in establishing the use case",
      imagePrompt: `Vertical 9:16 cinematic shot of a ${ctx.brand.niche} setting where a ${cat} is used, slow push-in, warm light, no text, no logos`,
    },
    {
      sceneIndex: scene(4),
      type: "generated_image",
      description: "Clean backdrop for benefit bullets",
      imagePrompt: `Vertical 9:16 soft-focus ${ctx.brand.niche} background, minimal, plenty of empty space, no text, no logos`,
      motion: "pan_left",
    },
    { sceneIndex: scene(5), type: "text_card", description: "Brand gradient CTA card" },
  ];
  const caption = [
    `${stripMarks(hook.text)}.`,
    ctx.research.positioning,
    facts
      .slice(0, 3)
      .map((f) => `✓ ${shortFact(f.claim, 12)}`)
      .join("\n"),
    `${cta}.`,
  ].join("\n\n");
  const hashtags = [
    ...new Set([...p.tags, cat.replace(/\s+/g, ""), ctx.brand.niche.split(/[\s&,]+/)[0] ?? ""]),
  ]
    .filter(Boolean)
    .slice(0, 5)
    .map((t) => `#${t.replace(/[^\p{L}\p{N}_]/gu, "").toLowerCase()}`);
  const variants = [1, 2, 3].map((v) =>
    hookFor(ANGLES[(ANGLES.indexOf(ctx.idea.angle as ContentAngle) + v + 8) % ANGLES.length]!, p, v),
  );
  return {
    hook: truncate(hook.text, 140),
    hookStyle: hook.style,
    angle: truncate(String(ctx.idea.angle).replace(/_/g, " "), 240),
    targetAudience: truncate(ctx.brand.targetAudience, 240),
    script,
    visualPlan,
    cta: truncate(cta, 90),
    ctaType: ctaTypeFor(cta),
    caption: truncate(caption, 1800),
    hashtags,
    estimatedDuration: Math.round(script.reduce((s, b) => s + b.durationSec, 0) * 10) / 10,
    commercialIntent: truncate(
      `Drive ${ctx.economicOutcome.toLowerCase().replace(/_/g, " ")} for ${name}`,
      240,
    ),
    confidence: 0.62,
    claimsUsed: facts.slice(0, 3).map((f) => f.id),
    hookVariants: variants.map((v) => ({ text: truncate(v.text, 140), style: v.style })),
  };
}

export function mockHooks(ctx: HooksContext): HookVariantsOutput {
  const avoid = new Set([ctx.currentHook, ...ctx.avoidHooks].map((h) => stripMarks(h).toLowerCase()));
  const hooks: HookVariantsOutput["hooks"] = [];
  for (let i = 0; i < ANGLES.length * 2 && hooks.length < ctx.count; i++) {
    const h = hookFor(ANGLES[i % ANGLES.length]!, ctx.product, Math.floor(i / ANGLES.length));
    if (avoid.has(stripMarks(h.text).toLowerCase())) continue;
    avoid.add(stripMarks(h.text).toLowerCase());
    hooks.push({
      text: h.text,
      style: h.style,
      rationale: "Concrete, curiosity-driven opener grounded in the product category.",
    });
  }
  return {
    hooks: hooks.length
      ? hooks
      : [
          {
            text: `Watch this before buying a *${categoryNoun(ctx.product)}*`,
            style: "mistake_warning",
            rationale: "fallback",
          },
        ],
  };
}

export function mockCaptions(ctx: CaptionsContext): PlatformCaptionsOutput {
  return {
    variants: ctx.platforms.map((p) => {
      const linkLine = p.linkClickable ? "Tap the link to check it out." : "Link in bio.";
      const body =
        p.platform === "TIKTOK"
          ? `${stripMarks(ctx.hook)} ${ctx.masterCaption.split("\n\n")[1] ?? ""}`.trim()
          : ctx.masterCaption.replace(/Link in bio\.?/gi, "").trim();
      const caption = truncate(`${body}\n\n${linkLine}`, Math.min(p.maxChars, 2000));
      return {
        platform: p.platform,
        caption,
        hashtags: ctx.hashtags.slice(0, p.maxHashtags),
      };
    }),
  };
}

const RISKY =
  /\b(guaranteed|best in the world|#1|miracle|cure[sd]?|clinically proven|100% safe|risk[- ]free|lowest price)\b/i;

export function mockQaReview(ctx: QaContext): QaReviewOutput {
  const issues: QaReviewOutput["issues"] = [];
  const all = [ctx.hook, ...ctx.onScreenTexts, ctx.voiceover, ctx.caption].join("\n");
  for (const word of ctx.brand.bannedWords) {
    if (word && all.toLowerCase().includes(word.toLowerCase())) {
      issues.push({
        type: "compliance",
        severity: "blocker",
        excerpt: word,
        explanation: "Banned word for this brand.",
      });
    }
  }
  const risky = RISKY.exec(all);
  if (risky) {
    issues.push({
      type: "unsupported_claim",
      severity: "major",
      excerpt: risky[0],
      explanation: "Claim not supported by product facts.",
    });
  }
  return {
    issues,
    overallAssessment: issues.length
      ? "Issues found — see list."
      : "Clear, on-brand and grounded in the provided facts.",
    score: Math.max(0, 94 - issues.length * 20),
  };
}

export function mockClassify(ctx: ClassifyContext): { label: string; confidence: number } {
  const text = ctx.text.toLowerCase();
  const hit = ctx.labels.find((l) => text.includes(l.toLowerCase().replace(/_/g, " ")));
  return { label: hit ?? ctx.labels[0] ?? "unknown", confidence: hit ? 0.8 : 0.4 };
}

export function mockScore(ctx: ScoreContext): { score: number; rationale: string } {
  const r = seededRandom(ctx.text)();
  return { score: Math.round(45 + r * 40), rationale: "Mock score (deterministic)." };
}

export const MOCK_GENERATORS: Record<string, (ctx: never) => unknown> = {
  "strategy.ideas": mockIdeas,
  "strategy.research": mockResearch,
  "script.short_video": mockScript,
  "hooks.variants": mockHooks,
  "caption.platform": mockCaptions,
  "qa.text_review": mockQaReview,
  "scoring.classify": mockClassify,
  "scoring.score": mockScore,
};
