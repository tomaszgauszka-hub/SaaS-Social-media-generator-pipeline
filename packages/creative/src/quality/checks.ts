import type { CreativeBrief } from "../brief.ts";
import type { CreativeStoryboard, LocalePack, RenderPlan } from "../model.ts";
import type { ResolveIssue } from "../resolve.ts";
import { stripEmphasis } from "../text-fit.ts";
import type { QaCheck, SimpleQaReport } from "./types.ts";

/**
 * Factual, Compliance and Localization QA (spec §43–§45) — separate from creative quality on purpose.
 * Rules are deterministic; an LLM is never asked whether a claim is true.
 */
const NUM = /\d+(?:[.,]\d+)*/g;
const normNum = (s: string) => s.replace(/[.,](?=\d{3}\b)/g, "").replace(",", ".");

function numbersIn(text: string): string[] {
  return (stripEmphasis(text).match(NUM) ?? []).map(normNum);
}

/** Every product fact the brief asserts (the only allowed source of numbers and claims). */
export function briefFacts(brief: CreativeBrief): string[] {
  const out: string[] = [
    brief.product.name,
    brief.product.shortName,
    brief.product.tagline ?? "",
    brief.product.eyebrow ?? "",
  ];
  for (const f of brief.features) {
    out.push(f.title, f.callout ?? "");
    if (f.stat)
      out.push(
        `${f.stat.value} ${f.stat.unit}`,
        `${f.stat.from}`,
        f.stat.label,
        f.stat.max ? `${f.stat.max}` : "",
      );
  }
  for (const it of brief.specs?.items ?? []) out.push(it.label, it.value);
  out.push(...(brief.checklist?.items ?? []), ...(brief.recap?.items ?? []), ...(brief.steps?.items ?? []));
  if (brief.inUse?.timer) out.push(`${brief.inUse.timer.seconds}`, brief.inUse.timer.label ?? "");
  return out.filter(Boolean);
}

export function factualQa(input: {
  brief: CreativeBrief;
  pack: LocalePack;
  plan: RenderPlan;
  sourcePack?: LocalePack;
}): SimpleQaReport {
  const allowed = new Set(briefFacts(input.brief).flatMap(numbersIn));
  const checks: QaCheck[] = [];
  let unverified = 0;
  for (const [slot, value] of Object.entries(input.pack.strings)) {
    // feature numbering ("No. 01") is structure, not a claim
    const structural = /\.eyebrow$/.test(slot) ? /^0?[1-9]$/ : null;
    const bad = numbersIn(value).filter((n) => !allowed.has(n) && !(structural && structural.test(n)));
    if (bad.length) {
      unverified += bad.length;
      checks.push({
        id: `num:${slot}`,
        label: `Number not in the product facts (${slot})`,
        status: "fail",
        value: bad.join(", "),
        expected: "a number stated in the brief",
      });
    }
  }
  for (const b of input.plan.beats)
    for (const o of b.overlays)
      if (o.kind === "counter" && !allowed.has(normNum(String(o.to)))) {
        unverified++;
        checks.push({
          id: `counter:${o.id}`,
          label: "Animated number not in the product facts",
          status: "fail",
          value: String(o.to),
        });
      }
  // localized copy must keep every number of the source copy
  if (input.sourcePack)
    for (const [slot, src] of Object.entries(input.sourcePack.strings)) {
      const target = numbersIn(input.pack.strings[slot] ?? "");
      const missing = numbersIn(src).filter((n) => !target.includes(n));
      if (missing.length) {
        unverified += missing.length;
        checks.push({
          id: `locked:${slot}`,
          label: `Translation changed a number (${slot})`,
          status: "fail",
          value: missing.join(", "),
        });
      }
    }
  if (!checks.length)
    checks.push({
      id: "facts",
      label: "Every on-screen number traces to the product facts",
      status: "pass",
      value: `${allowed.size} known values`,
    });
  const score = Math.max(0, 100 - unverified * 20);
  return { version: 1, score, status: unverified ? "FAIL" : "PASS", checks };
}

const PROHIBITED =
  /\b(cures?|heals?|guarantee[sd]?|risk[- ]free|#1|number one|best ever|miracle|clinically proven|doctor[- ]recommended|fda[- ]approved)\b/i;
const MEDICAL =
  /\b(anti[- ]?aging|wrinkles?|acne|eczema|dermatolog\w*|therap\w*|treats?|treatment|skin (repair|healing)|collagen boost)\b/i;
const FAKE_REVIEW =
  /\b(i tested|we tested|my review|our review|5[- ]stars?|customers love|verified buyer|our tests? show|i've been using)\b/i;
const URGENCY = /\b(only \d+ left|last chance|today only|selling out|ends tonight)\b/i;

export function complianceQa(input: {
  storyboard: CreativeStoryboard;
  plan: RenderPlan;
  pack: LocalePack;
  /** affiliate / sponsored content → visible disclosure required */
  affiliate: boolean;
}): SimpleQaReport {
  const { storyboard: sb, plan, pack } = input;
  const checks: QaCheck[] = [];
  const add = (c: QaCheck) => checks.push(c);
  const disclosure = plan.global.disclosure;
  add({
    id: "disclosure",
    label: "Affiliate disclosure on screen for the whole reel",
    status: !input.affiliate || (disclosure && disclosure.lines.length > 0) ? "pass" : "fail",
    value: disclosure
      ? disclosure.lines
          .flat()
          .map((s) => s.text)
          .join("")
      : "none",
    expected: input.affiliate ? "visible disclosure" : "not required",
  });
  const placeholder = sb.flags.placeholderMedia || sb.flags.demoOnly;
  add({
    id: "demo-label",
    label: "Placeholder / demo media is labelled",
    status: !placeholder || plan.global.demoLabel ? "pass" : "fail",
    value: plan.global.demoLabel ?? "—",
    expected: placeholder ? "burned-in DEMO label" : "not required",
  });
  const text = Object.entries(pack.strings).map(([slot, v]) => [slot, stripEmphasis(v)] as const);
  const scan = (id: string, label: string, re: RegExp, status: "fail" | "warn") => {
    const hits = text.filter(([, v]) => re.test(v));
    add({
      id,
      label,
      status: hits.length ? status : "pass",
      value: hits.length ? hits.map(([s, v]) => `${s}: "${v}"`).join("; ") : "none",
    });
  };
  scan("claims", "No prohibited / absolute claims", PROHIBITED, "fail");
  scan("medical", "No medical or skin-treatment claims", MEDICAL, "fail");
  scan("reviews", "No fake reviews, tests or testimonials", FAKE_REVIEW, "fail");
  scan("urgency", "No fabricated urgency", URGENCY, "warn");
  const fail = checks.some((c) => c.status === "fail");
  return { version: 1, score: fail ? 0 : 100, status: fail ? "FAIL" : "PASS", checks };
}

export function localizationQa(input: {
  storyboard: CreativeStoryboard;
  pack: LocalePack;
  resolveIssues: ResolveIssue[];
}): SimpleQaReport {
  const checks: QaCheck[] = [];
  const missing = Object.keys(input.storyboard.textSlots).filter((s) => !input.pack.strings[s]?.trim());
  checks.push({
    id: "complete",
    label: "Every text slot has copy",
    status: missing.length ? "fail" : "pass",
    value: missing.length ? missing.join(", ") : `${Object.keys(input.storyboard.textSlots).length} slots`,
  });
  const overflow = input.resolveIssues.filter(
    (i) => i.code === "TEXT_OVERFLOW" || i.code === "WORD_TOO_LONG",
  );
  checks.push({
    id: "fit",
    label: "Copy fits at readable sizes",
    status: overflow.length ? "fail" : "pass",
    value: overflow.length ? overflow.map((i) => i.slot).join(", ") : "all fit",
  });
  const glyphs = input.resolveIssues.filter((i) => i.code === "MISSING_GLYPHS");
  checks.push({
    id: "glyphs",
    label: "Fonts cover every character",
    status: glyphs.length ? "fail" : "pass",
    value: glyphs.length ? glyphs.map((i) => i.message).join("; ") : `locale ${input.pack.locale}`,
  });
  const long = Object.entries(input.storyboard.textSlots).filter(
    ([slot, spec]) => stripEmphasis(input.pack.strings[slot] ?? "").length > spec.maxChars * 1.15,
  );
  checks.push({
    id: "length",
    label: "Within slot character budgets",
    status: long.length ? "warn" : "pass",
    value: long.length ? long.map(([s]) => s).join(", ") : "ok",
  });
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const score = Math.max(0, 100 - fails * 30 - warns * 5 - overflow.length * 5);
  return { version: 1, score, status: fails ? "FAIL" : "PASS", checks };
}
