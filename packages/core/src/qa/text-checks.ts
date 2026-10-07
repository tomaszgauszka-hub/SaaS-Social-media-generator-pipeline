import { CONTENT_DEFAULTS } from "@cre/config";
import { formatUsd, maxSimilarity, wordCount, type Micros } from "@cre/shared";

/**
 * Deterministic text QA. Runs before anything reaches the approval queue. LLM review issues and media checks
 * are merged into the same issue list by the pipeline's QA step.
 */
export type QaSeverity = "blocker" | "major" | "minor" | "info";

export interface QaIssue {
  code: string;
  severity: QaSeverity;
  message: string;
  field?: string;
  platform?: string;
}

export const PENALTY: Record<QaSeverity, number> = { blocker: 40, major: 12, minor: 4, info: 0 };

export interface DisclosureRuleInput {
  platform: string | null;
  kind: "AFFILIATE" | "AD" | "SPONSORED" | "AI_GENERATED";
  text: string;
  placement: "CAPTION_START" | "CAPTION_END" | "ON_SCREEN" | "CAPTION_AND_ON_SCREEN";
  isRequired: boolean;
}

export interface TextQaInput {
  brand: { bannedWords: string[]; disclosureRules: DisclosureRuleInput[] };
  product: {
    title: string;
    priceMicros: Micros | null;
    priceFresh: boolean;
    facts: { id: string; claim: string }[];
  } | null;
  content: {
    hook: string;
    cta: string;
    onScreenTexts: string[];
    voiceover: string;
    caption: string;
    hashtags: string[];
    claimsUsed: string[];
    /** monetized link present (affiliate / referral) → disclosure required */
    isMonetized: boolean;
    aiGenerated: boolean;
    sceneKinds: string[];
  };
  variants: {
    platform: string;
    caption: string;
    hashtags: string[];
    disclosureText: string | null;
    destinationUrl: string | null;
  }[];
  recentHooks: string[];
  recentCaptions: string[];
}

const PLACEHOLDER =
  /\{\{|\}\}|\[(?:product|brand|insert|price|name|link|url|cta|todo)[^\]]*\]|<(?:insert|product|brand)[^>]*>|lorem ipsum|\bTODO\b|\bTBD\b|\bXXX\b|\bundefined\b|\bNaN\b|\[object Object\]/i;

/** Claim patterns that need a sourced fact behind them. */
const RISKY_CLAIMS: { re: RegExp; label: string }[] = [
  { re: /\b(?:guarantee[sd]?|guaranteed)\b/i, label: "guarantee" },
  { re: /\b(?:best|#1|number one|top[- ]rated|best[- ]selling)\b/i, label: "superlative" },
  { re: /\b(?:cheapest|lowest price|best price|best deal)\b/i, label: "price superlative" },
  {
    re: /\b(?:clinically|dermatologist|doctor)[- ](?:proven|tested|recommended|approved)\b/i,
    label: "clinical claim",
  },
  { re: /\b(?:cures?|heals?|treats?|prevents?)\b/i, label: "medical claim" },
  { re: /\b(?:risk[- ]free|100% safe|no side effects)\b/i, label: "safety claim" },
  { re: /\b(?:passive income|get rich|make \$?\d+)\b/i, label: "income claim" },
  { re: /\b(?:only \d+ left|selling out|last chance|ends tonight)\b/i, label: "scarcity claim" },
  {
    re: /\b(?:i tried|i've been using|my skin|we tested|i tested|changed my life)\b/i,
    label: "personal-experience claim",
  },
];

const SPEC_TOKEN =
  /\b\d[\d,.]*\s?(?:v|rpm|ml|mah|w|ft|in|inch(?:es)?|%|mm|cm|kg|lb|lbs|oz|hours?|hrs?|days?|gb|tb)\b/gi;
const PRICE_TOKEN = /(?:\$|€|£)\s?(\d+(?:[.,]\d{1,2})?)/g;

function normalizeNumberToken(t: string): string {
  return t
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/,/g, "")
    .replace(/inches|inch/, "in")
    .replace(/lbs/, "lb")
    .replace(/hours|hrs|hr/, "hour");
}

function textBlocks(
  c: TextQaInput["content"],
  variants: TextQaInput["variants"],
): { field: string; text: string; platform?: string }[] {
  return [
    { field: "hook", text: c.hook },
    { field: "cta", text: c.cta },
    ...c.onScreenTexts.map((t, i) => ({ field: `onScreen[${i}]`, text: t })),
    { field: "voiceover", text: c.voiceover },
    { field: "caption", text: c.caption },
    ...variants.map((v) => ({ field: "variant.caption", text: v.caption, platform: v.platform })),
  ];
}

function containsWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

export function runTextChecks(input: TextQaInput): QaIssue[] {
  const issues: QaIssue[] = [];
  const c = input.content;
  const blocks = textBlocks(c, input.variants);
  const factsText = (input.product?.facts ?? [])
    .map((f) => f.claim)
    .join(" \n ")
    .toLowerCase();

  // 1. placeholders / template leaks
  for (const b of blocks) {
    const m = PLACEHOLDER.exec(b.text);
    if (m) {
      issues.push({
        code: "placeholder",
        severity: "blocker",
        message: `Unfilled placeholder "${m[0]}"`,
        field: b.field,
        ...(b.platform ? { platform: b.platform } : {}),
      });
    }
  }

  // 2. banned words
  for (const word of input.brand.bannedWords) {
    for (const b of blocks) {
      if (word && containsWord(b.text, word)) {
        issues.push({
          code: "banned_word",
          severity: "blocker",
          message: `Banned word "${word}"`,
          field: b.field,
          ...(b.platform ? { platform: b.platform } : {}),
        });
        break;
      }
    }
  }

  // 3. CTA presence
  if (!c.cta.trim())
    issues.push({ code: "missing_cta", severity: "major", message: "No call to action", field: "cta" });
  if (c.sceneKinds.length && c.sceneKinds.at(-1) !== "CTA") {
    issues.push({
      code: "cta_not_last",
      severity: "minor",
      message: "Last scene is not a CTA scene",
      field: "script",
    });
  }
  for (const v of input.variants) {
    if (!/(link|bio|comment|tap|click|save|dm|shop|check)/i.test(v.caption)) {
      issues.push({
        code: "caption_without_cta",
        severity: "minor",
        message: "Caption has no call to action",
        platform: v.platform,
      });
    }
  }

  // 4. disclosures (FTC / ASA / platform rules)
  for (const v of input.variants) {
    for (const rule of input.brand.disclosureRules) {
      if (!rule.isRequired) continue;
      if (rule.platform && rule.platform !== v.platform) continue;
      const applies = rule.kind === "AI_GENERATED" ? c.aiGenerated : c.isMonetized;
      if (!applies) continue;
      const needsCaption = rule.placement !== "ON_SCREEN";
      const needsOnScreen = rule.placement === "ON_SCREEN" || rule.placement === "CAPTION_AND_ON_SCREEN";
      const caption = v.caption.toLowerCase();
      const ruleText = rule.text.toLowerCase();
      if (needsCaption && !caption.includes(ruleText)) {
        issues.push({
          code: rule.kind === "AI_GENERATED" ? "missing_ai_label" : "missing_disclosure",
          severity: rule.kind === "AI_GENERATED" ? "major" : "blocker",
          message: `Required ${rule.kind.toLowerCase().replace("_", " ")} disclosure "${rule.text}" missing from caption`,
          platform: v.platform,
        });
      } else if (needsCaption && rule.placement === "CAPTION_START" && rule.kind !== "AI_GENERATED") {
        const firstLine = caption.split("\n")[0] ?? "";
        if (!firstLine.includes(ruleText)) {
          issues.push({
            code: "disclosure_not_prominent",
            severity: "major",
            message: `Disclosure must appear at the start of the caption`,
            platform: v.platform,
          });
        }
      }
      if (needsOnScreen && !c.onScreenTexts.some((t) => t.toLowerCase().includes(ruleText))) {
        issues.push({
          code: "missing_onscreen_disclosure",
          severity: "blocker",
          message: `On-screen disclosure "${rule.text}" missing`,
          platform: v.platform,
        });
      }
    }
  }

  // 5. unsupported claims (must be backed by a sourced fact)
  const reported = new Set<string>();
  for (const b of blocks) {
    for (const { re, label } of RISKY_CLAIMS) {
      const m = re.exec(b.text);
      if (m && !factsText.includes(m[0].toLowerCase()) && !reported.has(`${label}:${m[0].toLowerCase()}`)) {
        reported.add(`${label}:${m[0].toLowerCase()}`);
        issues.push({
          code: "unsupported_claim",
          severity: label.includes("medical") || label.includes("personal") ? "blocker" : "major",
          message: `Unsupported ${label}: "${m[0]}"`,
          field: b.field,
        });
      }
    }
    for (const token of b.text.match(SPEC_TOKEN) ?? []) {
      const norm = normalizeNumberToken(token);
      if (!normalizeNumberToken(factsText).includes(norm) && !reported.has(`spec:${norm}`)) {
        reported.add(`spec:${norm}`);
        issues.push({
          code: "unsourced_number",
          severity: "major",
          message: `"${token}" is not in the product facts`,
          field: b.field,
        });
      }
    }
  }

  // 6. price consistency
  const priceMentions = blocks.flatMap((b) =>
    [...b.text.matchAll(PRICE_TOKEN)].map((m) => ({ b, value: Number(m[1]!.replace(",", ".")) })),
  );
  if (priceMentions.length) {
    const p = input.product;
    if (!p || p.priceMicros === null) {
      issues.push({
        code: "price_without_source",
        severity: "blocker",
        message: "Content mentions a price but the product has no verified price",
      });
    } else {
      if (!p.priceFresh)
        issues.push({
          code: "stale_price",
          severity: "major",
          message: `Price mentioned but last verified more than ${CONTENT_DEFAULTS.priceStaleDays} days ago`,
        });
      for (const m of priceMentions) {
        if (Math.abs(Math.round(m.value * 1_000_000) - p.priceMicros) > 10_000) {
          issues.push({
            code: "price_mismatch",
            severity: "blocker",
            message: `Price ${m.value} contradicts verified price ${formatUsd(p.priceMicros)}`,
            field: m.b.field,
          });
          break;
        }
      }
    }
  }

  // 7. claims referencing unknown facts
  const factIds = new Set((input.product?.facts ?? []).map((f) => f.id));
  const unknown = c.claimsUsed.filter((id) => !factIds.has(id));
  if (unknown.length)
    issues.push({
      code: "unknown_fact_reference",
      severity: "major",
      message: `Script cites unknown fact ids: ${unknown.join(", ")}`,
    });

  // 8. product name consistency
  if (input.product) {
    const key = input.product.title
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 2);
    const all = blocks.map((b) => b.text.toLowerCase()).join(" ");
    if (key.length && !key.some((k) => all.includes(k.toLowerCase()))) {
      issues.push({
        code: "product_not_named",
        severity: "minor",
        message: "The product is never named in the content",
      });
    }
  }

  // 9. duplicates
  const hookSim = maxSimilarity(c.hook, input.recentHooks);
  if (hookSim.score >= CONTENT_DEFAULTS.duplicateHookSimilarity) {
    issues.push({
      code: "duplicate_hook",
      severity: "major",
      message: `Hook is ${Math.round(hookSim.score * 100)}% similar to a recent hook: "${input.recentHooks[hookSim.index]}"`,
      field: "hook",
    });
  }
  const capSim = maxSimilarity(c.caption, input.recentCaptions);
  if (capSim.score >= 0.9)
    issues.push({
      code: "duplicate_caption",
      severity: "minor",
      message: "Caption nearly identical to a recent caption",
      field: "caption",
    });

  // 10. platform limits
  for (const v of input.variants) {
    const maxChars = CONTENT_DEFAULTS.captionMaxChars[v.platform] ?? 2200;
    if (v.caption.length > maxChars) {
      issues.push({
        code: "caption_too_long",
        severity: "major",
        message: `Caption ${v.caption.length}/${maxChars} characters`,
        platform: v.platform,
      });
    }
    const maxTags = CONTENT_DEFAULTS.maxHashtags[v.platform] ?? 5;
    if (v.hashtags.length > maxTags) {
      issues.push({
        code: "too_many_hashtags",
        severity: "minor",
        message: `${v.hashtags.length} hashtags (max ${maxTags})`,
        platform: v.platform,
      });
    }
    if (v.hashtags.some((h) => !/^#[\p{L}\p{N}_]+$/u.test(h))) {
      issues.push({
        code: "invalid_hashtag",
        severity: "minor",
        message: "Malformed hashtag",
        platform: v.platform,
      });
    }
    if (c.isMonetized && v.destinationUrl !== null && !isValidHttpUrl(v.destinationUrl)) {
      issues.push({
        code: "broken_url",
        severity: "blocker",
        message: `Invalid destination URL`,
        platform: v.platform,
      });
    }
    if (c.isMonetized && v.destinationUrl === null) {
      issues.push({
        code: "missing_link",
        severity: "blocker",
        message: "Monetized content has no tracked link",
        platform: v.platform,
      });
    }
  }

  // 11. copy hygiene (cheap spelling/grammar heuristics; the LLM review catches the rest)
  for (const b of blocks) {
    if (/\b(\w+)\s+\1\b/i.test(b.text))
      issues.push({ code: "repeated_word", severity: "minor", message: "Repeated word", field: b.field });
    if (/[!?]{3,}/.test(b.text))
      issues.push({
        code: "excessive_punctuation",
        severity: "minor",
        message: "Excessive punctuation",
        field: b.field,
      });
    if ((b.text.match(/\*/g)?.length ?? 0) % 2 === 1)
      issues.push({
        code: "unbalanced_markup",
        severity: "minor",
        message: "Unbalanced *highlight* markup",
        field: b.field,
      });
    const letters = b.text.replace(/[^A-Za-z]/g, "");
    if (
      b.field.includes("caption") &&
      letters.length > 40 &&
      letters.replace(/[^A-Z]/g, "").length / letters.length > 0.6
    ) {
      issues.push({
        code: "shouting",
        severity: "minor",
        message: "Caption is mostly upper case",
        field: b.field,
      });
    }
  }
  if (wordCount(c.hook.replace(/\*/g, "")) > 10)
    issues.push({
      code: "long_hook",
      severity: "minor",
      message: "Hook longer than 10 words",
      field: "hook",
    });

  return dedupe(issues);
}

function dedupe(issues: QaIssue[]): QaIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.code}|${i.field ?? ""}|${i.platform ?? ""}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && Boolean(u.hostname.includes("."));
  } catch {
    return false;
  }
}

export interface QaScore {
  score: number;
  passed: boolean;
  blockers: number;
  majors: number;
  minors: number;
}

/** 100 − penalties; any blocker fails regardless of score. */
export function scoreIssues(issues: QaIssue[], threshold: number): QaScore {
  const score = Math.max(0, 100 - issues.reduce((s, i) => s + PENALTY[i.severity], 0));
  const blockers = issues.filter((i) => i.severity === "blocker").length;
  return {
    score,
    passed: blockers === 0 && score >= threshold,
    blockers,
    majors: issues.filter((i) => i.severity === "major").length,
    minors: issues.filter((i) => i.severity === "minor").length,
  };
}
