import { productFirstVisibleMs } from "../director.ts";
import { mediaShowsProduct, type CreativeStoryboard, type Palette, type RenderPlan } from "../model.ts";
import type { ResolveIssue } from "../resolve.ts";
import { STRUCTURES } from "../structures.ts";
import { readingTimeMs } from "../subtitles.ts";
import { stripEmphasis } from "../text-fit.ts";
import { visualCoverage } from "./coverage.ts";
import type { CreativeQaReport, QualityFactor, TechnicalQaReport } from "./types.ts";

/**
 * Creative QA (spec §39–§42) — CreativeQualityScore from the storyboard, the measured render plan and the
 * technical frame analysis. Deterministic heuristics, no model calls; it catches the structural reasons a
 * reel fails (late product, slow hook, text walls, repetition, static beats). It does NOT replace a human
 * visual review — the score says "no known defects", not "this will perform".
 */
export interface CreativeQaInput {
  storyboard: CreativeStoryboard;
  plan: RenderPlan;
  resolveIssues: ResolveIssue[];
  technical?: TechnicalQaReport;
}

const DEMO_TYPES = new Set(["PRODUCT_IN_USE", "SCREEN_DEMO", "BEFORE_AFTER", "SIDE_BY_SIDE", "PROCESS_STEP"]);
const TYPE_PURPOSE: Partial<
  Record<string, (typeof STRUCTURES)[keyof typeof STRUCTURES]["required"][number]>
> = {
  PROBLEM_VISUAL: "PROBLEM",
  SOLUTION_VISUAL: "SOLUTION",
  PRODUCT_HERO: "PRODUCT",
  PRODUCT_IN_USE: "DEMO",
  SCREEN_DEMO: "DEMO",
  BEFORE_AFTER: "COMPARISON",
  SIDE_BY_SIDE: "COMPARISON",
};
const CTA_VERBS =
  /^(see|get|shop|check|find|discover|grab|try|explore|compare|view|learn|order|buy|watch|start|claim)\b/i;

function hexLum(hex: string): number {
  const h = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => {
    const v = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

export function contrastRatio(a: string, b: string): number {
  const [x, y] = [hexLum(a), hexLum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

function hammingHex(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = Number.parseInt(a[i]!, 16) ^ Number.parseInt(b[i]!, 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

const clampScore = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

export function creativeQa(input: CreativeQaInput): CreativeQaReport {
  const { storyboard: sb, plan, resolveIssues, technical } = input;
  const beats = plan.beats;
  const mediaById = new Map(sb.media.map((m) => [m.id, m]));
  const showsProduct = (b: (typeof beats)[number]) =>
    b.media.some((m) => {
      const ref = mediaById.get(m.assetId);
      return ref ? mediaShowsProduct(ref) : false;
    });
  const factors: QualityFactor[] = [];
  const hardFails: string[] = [];
  const warnings: string[] = [];
  const factor = (id: string, label: string, weight: number, score: number, notes: string[]) =>
    factors.push({ id, label, weight, score: clampScore(score), notes });
  const beatWords = (b: (typeof beats)[number]) => {
    let w = 0;
    for (const t of b.texts)
      w += t.lines.flat().reduce((s, sp) => s + sp.text.split(/\s+/).filter(Boolean).length, 0);
    for (const t of Object.values(b.overlayTexts))
      w += t.lines.flat().reduce((s, sp) => s + sp.text.split(/\s+/).filter(Boolean).length, 0);
    return w;
  };

  // 1. hook
  {
    const notes: string[] = [];
    let s = 100;
    const first = beats[0];
    if (!first || first.purpose !== "HOOK") {
      s -= 40;
      notes.push("first beat is not a hook");
    }
    const hookText = first?.texts.find((t) => t.role === "DISPLAY" || t.role === "HEADLINE");
    const hookWords = hookText
      ? hookText.lines.flat().reduce((a, sp) => a + sp.text.split(/\s+/).filter(Boolean).length, 0)
      : 0;
    if (!hookText) {
      s -= 25;
      notes.push("no hook line");
    } else if (hookWords > 10) {
      s -= 15;
      notes.push(`hook is ${hookWords} words (≤ 10 reads in time)`);
    }
    const firstTextMs = first ? Math.min(...first.texts.map((t) => t.delayMs), 9999) : 9999;
    if (firstTextMs > 400) {
      s -= 15;
      notes.push(`hook text appears at ${firstTextMs} ms`);
    }
    const productAt = productFirstVisibleMs(sb);
    if (productAt === null) s -= 50;
    else if (productAt > 2000) {
      s -= 25;
      notes.push(`product first visible at ${(productAt / 1000).toFixed(1)} s`);
    } else if (productAt > 1000) {
      s -= 10;
      notes.push(`product first visible at ${(productAt / 1000).toFixed(1)} s`);
    } else notes.push(`product on screen at ${(productAt / 1000).toFixed(1)} s`);
    if (first && (first.durationMs < 1500 || first.durationMs > 4200)) {
      s -= 10;
      notes.push(`hook beat lasts ${(first.durationMs / 1000).toFixed(1)} s`);
    }
    if (!plan.audio.sfx.some((c) => c.atMs < 400)) {
      s -= 5;
      notes.push("no sound accent in the first 0.4 s");
    }
    const m0 = technical?.metrics.beats[0]?.motion;
    if (m0 !== undefined && m0 < 0.8) {
      s -= 10;
      notes.push("first beat is visually static");
    }
    factor("hook", "Hook (first 2 s)", 14, s, notes);
  }

  // 2. product visibility
  {
    const notes: string[] = [];
    const share = beats.filter(showsProduct).length / Math.max(1, beats.length);
    let s = Math.min(100, (share / 0.6) * 100);
    notes.push(`product visible in ${Math.round(share * 100)} % of beats`);
    // prominence: frame area of the product layer where the product is the subject (scenes count as 30 %)
    const areas = beats.filter(showsProduct).map((b) => {
      const layer = b.media.find((m) =>
        mediaShowsProduct(mediaById.get(m.assetId) ?? { role: "scene", showsProduct: false }),
      );
      if (!layer) return 0;
      const ref = mediaById.get(layer.assetId)!;
      if (ref.role === "scene" || ref.role === "ui" || layer.crop === "cover" || layer.crop === "macro")
        return 0.3;
      const k = Math.min(layer.box.w / ref.width, layer.box.h / ref.height);
      return (ref.width * k * ref.height * k) / (plan.format.width * plan.format.height);
    });
    const prominence = areas.length ? areas.reduce((a, v) => a + v, 0) / areas.length : 0;
    if (prominence < 0.18) {
      s -= Math.round((0.18 - prominence) * 150);
      notes.push(`product fills ~${Math.round(prominence * 100)} % of the frame on average`);
    }
    const cta = beats[beats.length - 1];
    if (cta && !showsProduct(cta)) {
      s -= 20;
      notes.push("CTA without the product");
    }
    if (productFirstVisibleMs(sb) === null) {
      hardFails.push("Product is never shown");
      s = 0;
    }
    factor("productVisibility", "Product visibility", 12, s, notes);
  }

  // 3. scene variety — distinct shots (layout × main image × framing), not just distinct templates
  {
    const shotKey = (b: (typeof beats)[number]) => {
      const main = b.media.find((m) => m.slot !== "background") ?? b.media[0];
      return `${b.layout}|${main?.assetId ?? "none"}|${main?.crop ?? ""}|${main?.focus ?? ""}|${JSON.stringify(main?.params ?? {})}`;
    };
    const shots = new Set(beats.map(shotKey)).size;
    const images = new Set(beats.flatMap((b) => b.media.map((m) => m.assetId))).size;
    const n = Math.max(1, beats.length);
    const s = (Math.min(1, shots / n / 0.85) * 0.7 + Math.min(1, images / Math.min(n, 4)) * 0.3) * 100;
    factor("sceneVariety", "Scene / shot variety", 9, s, [
      `${shots} distinct shots, ${images} different images across ${beats.length} beats`,
    ]);
  }

  // 3b. meaningful visual coverage — imagery carries the story, text supports it
  const coverage = visualCoverage(sb, plan);
  {
    const notes: string[] = [];
    const c = coverage.meaningfulVisualCoverage;
    const tOnly = coverage.textOnlyDurationRatio;
    let s = Math.min(100, (c / 0.8) * 100);
    if (tOnly > 0.15) s -= Math.round((tOnly - 0.15) * 200);
    notes.push(`meaningful imagery ${Math.round(c * 100)} % of the reel (target ≥ 80 %)`);
    notes.push(`text-only ${Math.round(tOnly * 100)} % (target ≤ 15 %, fail > 25 %)`);
    const weak = coverage.beats.filter((b) => b.meaningfulMs < b.durationMs * 0.5);
    if (weak.length)
      notes.push(
        `text-led beats: ${weak.map((b) => `${b.beatId} (${Math.round(b.visualShare * 100)} % image)`).join(", ")}`,
      );
    if (tOnly > 0.25)
      hardFails.push(`Text-only frames for ${Math.round(tOnly * 100)} % of the reel (max 25 %)`);
    factor("visualCoverage", "Meaningful visual coverage", 12, s, notes);
  }

  // 4. visual storytelling
  {
    const notes: string[] = [];
    let s = 100;
    // a problem-first hook is also the PROBLEM beat
    const purposes = new Set(
      beats.flatMap((b) => [b.purpose, ...(TYPE_PURPOSE[b.type] ? [TYPE_PURPOSE[b.type]!] : [])]),
    );
    for (const req of STRUCTURES[sb.structure].required)
      if (!purposes.has(req)) {
        s -= 25;
        notes.push(`structure ${sb.structure} misses a ${req} beat`);
      }
    if (!beats.some((b) => DEMO_TYPES.has(b.type))) {
      s -= 20;
      notes.push("nothing is demonstrated (no in-use, screen, steps or comparison beat)");
    }
    if (beats.length < 6) {
      s -= 15;
      notes.push(`${beats.length} beats (≥ 6 expected)`);
    }
    if (beats.length < 4) hardFails.push(`Only ${beats.length} beats`);
    if (!notes.length)
      notes.push(`${sb.structure.replace(/_/g, " ").toLowerCase()} told in ${beats.length} beats`);
    factor("storytelling", "Visual storytelling", 10, s, notes);
  }

  // 5. pacing
  {
    const notes: string[] = [];
    let s = 100;
    const total = plan.durationMs / 1000;
    if (total < 15 || total > 30) {
      s -= 30;
      notes.push(`${total.toFixed(1)} s (15–30 s target)`);
    }
    for (const b of beats)
      if (b.durationMs < 1200 || b.durationMs > 5500) {
        s -= 8;
        notes.push(`${b.id} lasts ${(b.durationMs / 1000).toFixed(1)} s`);
      }
    const avg = plan.durationMs / Math.max(1, beats.length) / 1000;
    if (avg > 4.2) {
      s -= 15;
      notes.push(`average beat ${avg.toFixed(1)} s is slow for short-form`);
    }
    if (!notes.length) notes.push(`${total.toFixed(1)} s, average beat ${avg.toFixed(1)} s`);
    factor("pacing", "Pacing", 9, s, notes);
  }

  // 6. text density
  {
    const notes: string[] = [];
    let s = 100;
    let words = 0;
    for (const b of beats) {
      const w = beatWords(b);
      words += w;
      if (w > 22) {
        s -= 8;
        notes.push(`${b.id} shows ${w} words`);
      }
      for (const t of b.texts) {
        const value = t.lines
          .flat()
          .map((sp) => sp.text)
          .join(" ");
        const visible = b.durationMs - t.delayMs - t.exitBeforeEndMs;
        if (readingTimeMs(value) > visible) {
          s -= 10;
          notes.push(
            `${t.slot} needs ${(readingTimeMs(value) / 1000).toFixed(1)} s to read, visible ${(visible / 1000).toFixed(1)} s`,
          );
        }
      }
    }
    const wps = words / (plan.durationMs / 1000);
    if (wps > 3.2) {
      s -= 15;
      notes.push(`${wps.toFixed(1)} words/s overall`);
    }
    if (!notes.length)
      notes.push(`${words} words in ${(plan.durationMs / 1000).toFixed(0)} s (${wps.toFixed(1)}/s)`);
    factor("textDensity", "Text density", 8, s, notes);
  }

  // 7. typography
  {
    const notes: string[] = [];
    let s = 100;
    const overflow = resolveIssues.filter((i) => i.code === "TEXT_OVERFLOW" || i.code === "WORD_TOO_LONG");
    s -= overflow.length * 25;
    overflow.forEach((i) => notes.push(i.message));
    if (overflow.length)
      hardFails.push(`${overflow.length} text element(s) do not fit at the minimum readable size`);
    const glyphs = resolveIssues.filter((i) => i.code === "MISSING_GLYPHS");
    if (glyphs.length) {
      hardFails.push("Missing glyphs");
      s -= 40;
    }
    const families = new Set(
      plan.fonts
        .filter(
          (f) => !(f.family === "Inter" && f.weight === 700 && plan.style.fonts.BODY.family !== "Inter"),
        )
        .map((f) => f.family),
    );
    if (families.size > 2) {
      s -= 10;
      notes.push(`${families.size} font families`);
    }
    if (!notes.length) notes.push(`all text measured to fit; ${[...families].join(" + ")}`);
    factor("typography", "Typography", 8, s, notes);
  }

  // 8. legibility
  {
    const notes: string[] = [];
    let s = 100;
    const safe = resolveIssues.filter((i) => i.code === "SAFE_ZONE");
    s -= safe.length * 15;
    safe.slice(0, 3).forEach((i) => notes.push(i.message));
    for (const b of beats) {
      if (b.background !== "media") continue;
      for (const t of b.texts)
        if (t.surface === "none") {
          s -= 15;
          notes.push(`${t.slot} sits on imagery without a scrim`);
        }
    }
    const p: Palette = plan.style.palette;
    // WCAG: 4.5:1 for body text, 3:1 for large / bold text (accent ink only ever sets ≥ 30 px bold labels)
    const pairs: [string, string, string, number][] = [
      ["ink on background", p.ink, p.bg, 4.5],
      ["text on panels", p.surfaceInk, p.surface, 4.5],
      ["text on accent (large)", p.accentInk, p.accent, 3],
    ];
    for (const [label, fg, bg, min] of pairs) {
      const r = contrastRatio(fg, bg);
      if (r < min) {
        s -= 15;
        notes.push(`${label}: contrast ${r.toFixed(1)}:1 (< ${min})`);
      }
    }
    if (!notes.length) notes.push("safe zones respected, scrims on imagery, contrast ≥ 4.5:1");
    factor("legibility", "Legibility & safe zones", 9, s, notes);
  }

  // 9. brand consistency
  {
    const kit = plan.style.kit;
    factor("brand", "Brand / kit consistency", 5, 100, [`one style kit (${kit}) for every beat`]);
  }

  // 10. commercial clarity
  {
    const notes: string[] = [];
    let s = 100;
    const allText = beats
      .flatMap((b) => [...b.texts, ...Object.values(b.overlayTexts)])
      .map((t) =>
        t.lines
          .flat()
          .map((sp) => sp.text)
          .join(" "),
      )
      .join(" \n ");
    const named = beats.some((b) => b.type === "PRODUCT_HERO");
    if (!named) {
      s -= 25;
      notes.push("product is never named in a hero beat");
    }
    if (!beats.some((b) => ["FEATURE", "SPEC", "DEMO", "SOLUTION"].includes(b.purpose))) {
      s -= 25;
      notes.push("no benefit / feature beat");
    }
    if (!/\d/.test(allText)) {
      s -= 10;
      notes.push("no concrete number or spec on screen");
    }
    if (!notes.length) notes.push("named product, concrete features, clear offer");
    factor("commercialClarity", "Commercial clarity", 7, s, notes);
  }

  // 11. CTA
  {
    const notes: string[] = [];
    let s = 100;
    const cta = beats[beats.length - 1];
    if (!cta || cta.purpose !== "CTA") {
      hardFails.push("No CTA at the end");
      s = 0;
    } else {
      if (cta.durationMs < 2200) {
        s -= 15;
        notes.push(`CTA visible ${(cta.durationMs / 1000).toFixed(1)} s`);
      }
      const button = cta.overlays.find((o) => o.kind === "badge");
      const label =
        button && button.kind === "badge" ? stripEmphasis(cta.strings[button.textSlot] ?? "") : "";
      if (!label) {
        s -= 30;
        notes.push("no CTA button");
      } else {
        if (label.split(/\s+/).length > 4) {
          s -= 10;
          notes.push(`button "${label}" is long`);
        }
        if (!CTA_VERBS.test(label)) {
          s -= 10;
          notes.push(`button "${label}" does not start with an action verb`);
        }
      }
      if (!showsProduct(cta)) s -= 15;
      if (!notes.length) notes.push(`"${label}" with the product, ${(cta.durationMs / 1000).toFixed(1)} s`);
    }
    factor("cta", "CTA quality", 6, s, notes);
  }

  // 12. visual repetition (perceptual hashes of each beat)
  let repetitionScore = 100;
  {
    const notes: string[] = [];
    let s = 100;
    const hashes = technical?.metrics.beats ?? [];
    for (let i = 0; i < hashes.length; i++)
      for (let j = i + 1; j < hashes.length; j++) {
        const d = hammingHex(hashes[i]!.hash, hashes[j]!.hash);
        if (d <= 6) {
          s -= 15;
          notes.push(`${hashes[i]!.beatId} and ${hashes[j]!.beatId} look alike (dHash distance ${d})`);
        }
      }
    const uses = new Map<string, number>();
    for (const b of beats)
      for (const id of new Set(b.media.map((m) => m.assetId))) uses.set(id, (uses.get(id) ?? 0) + 1);
    for (const [id, n] of uses)
      if (n > 4 && !mediaShowsProduct(mediaById.get(id) ?? { role: "scene", showsProduct: false })) {
        s -= 10;
        notes.push(`${id} used in ${n} beats`);
      }
    if (!hashes.length) notes.push("no frame analysis available");
    else if (!notes.length) notes.push("every beat is visually distinct");
    repetitionScore = Math.max(0, s);
    factor("repetition", "Visual repetition", 6, s, notes);
  }

  // 13. production polish
  {
    const notes: string[] = [];
    let s = 100;
    if (plan.audio.sfx.length < beats.length / 2) {
      s -= 10;
      notes.push(`${plan.audio.sfx.length} sound cues`);
    }
    const transitions = new Set(beats.slice(1).map((b) => b.transitionIn.type)).size;
    if (transitions < 2) {
      s -= 10;
      notes.push("a single transition type");
    }
    if (technical) {
      if (technical.status === "FAIL") {
        s -= 40;
        hardFails.push("Technical QA failed");
      }
      if (technical.metrics.frozenSegments.length) {
        s -= 8 * technical.metrics.frozenSegments.length;
        notes.push(`${technical.metrics.frozenSegments.length} near-frozen hold(s)`);
      }
    } else warnings.push("No technical analysis — motion and repetition not measured");
    if (!notes.length) notes.push(`${plan.audio.sfx.length} sound cues, ${transitions} transition types`);
    factor("polish", "Production polish", 7, s, notes);
  }

  // 14. scene dynamics — no visually unchanged stretch longer than ~2.5 s (local frame similarity, no model)
  let longestStaticMs = 0;
  {
    const notes: string[] = [];
    let s = 100;
    const segs = technical?.metrics.staticSegments ?? [];
    for (const g of segs) {
      const d = g.endMs - g.startMs;
      longestStaticMs = Math.max(longestStaticMs, d);
      s -= d >= 4000 ? 30 : 20;
      notes.push(
        `unchanged ${(g.startMs / 1000).toFixed(1)}–${(g.endMs / 1000).toFixed(1)} s (${(d / 1000).toFixed(1)} s)`,
      );
    }
    if (!technical) notes.push("no frame analysis available");
    else if (!segs.length) notes.push("no visually unchanged stretch ≥ 2.5 s");
    factor("dynamics", "Scene dynamics", 7, s, notes);
  }

  if (sb.flags.placeholderMedia || sb.flags.demoOnly)
    warnings.push("Placeholder / demo media — NOT PRODUCTION READY whatever the score");
  for (const i of resolveIssues)
    if (i.severity === "blocker" && i.code === "MISSING_TEXT") hardFails.push(i.message);

  const wsum = factors.reduce((a, f) => a + f.weight, 0);
  let score = Math.round(factors.reduce((a, f) => a + f.score * f.weight, 0) / wsum);
  if (hardFails.length) score = Math.min(score, 59);
  return {
    version: 1,
    score,
    metrics: {
      meaningfulVisualCoverage: coverage.meaningfulVisualCoverage,
      textOnlyDurationRatio: coverage.textOnlyDurationRatio,
      visualRepetition: repetitionScore,
      longestStaticMs,
    },
    factors,
    hardFails,
    warnings,
  };
}
