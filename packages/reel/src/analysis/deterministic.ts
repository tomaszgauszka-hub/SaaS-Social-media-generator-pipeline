import { sha256Hex, stableStringify } from "@cre/shared";
import type { CallContext, ProductAnalyzer } from "../capabilities/types.ts";
import {
  ProductProfile,
  type LinkedPoint,
  type ProductFact,
  type ProductSource,
} from "../contracts/product.ts";
import { detectConcepts, type CategoryKey } from "../director/lexicon.ts";
import { decodeRaw } from "../util/raw.ts";

/**
 * Deterministic product analysis (local, free): category, traits, selling points and technical features as
 * fact-linked points, visual features / opportunities, claim risks and the catalog palette. It is the fallback
 * of the Gemini analyzer and good enough on its own for structured catalog data.
 */

export const DETERMINISTIC_ANALYZER_VERSION = "deterministic-analyzer/2";

export function sourceHash(source: ProductSource): string {
  return sha256Hex(stableStringify(source)).slice(0, 24);
}

// whole words only: "Light Grey", "Lightweight", "panel", "spot" or "that" must never decide a category
const CATEGORY_RULES: [CategoryKey, RegExp][] = [
  [
    "lighting",
    /\b(lamps?|lighting|lights?|light fixtures?|leuchten?|lampen?|lámparas?|lampade?|lampa|lampka|luminaires?|chandeliers?|sconces?)\b/i,
  ],
  [
    "tools",
    /\b(drills?|(screw)?drivers?|saws?|sanders?|grinders?|tools?|wrench(es)?|wkrętar\w*|bohr\w*|werkzeug\w*|taladros?)\b/i,
  ],
  [
    "beauty",
    /\b(creams?|serums?|sunscreens?|lotions?|cosmetics?|beauty|skin\s?care|hair\s?care|makeup|lipsticks?)\b/i,
  ],
  [
    "kitchen",
    /\b(kitchen|cookware|cooking|pans?|pots?|knife|knives|blenders?|kettles?|mugs?|cups?|plates?|küche|cocina)\b/i,
  ],
  [
    "electronics",
    /\b(phones?|smartphones?|speakers?|headphones?|chargers?|cameras?|tablets?|laptops?|monitors?|watch(es)?|electronics?)\b/i,
  ],
  [
    "fashion",
    /\b(t-?shirts?|shirts?|dress(es)?|shoes?|boots?|bags?|jackets?|jeans|hats?|apparel|clothing)\b/i,
  ],
  [
    "home",
    /\b(chairs?|tables?|sofas?|couch(es)?|shel(f|ves)|rugs?|pillows?|vases?|mirrors?|furniture|decor|home|beds?|cabinets?|stools?)\b/i,
  ],
];

/** colour and weight words that contain "light" but say nothing about a light source */
const LIGHT_ADJECTIVE =
  /\blight[\s-]*(?:weight|grey|gray|blue|brown|green|pink|beige|wood|oak|walnut|natural|tan|taupe|cream|white|yellow|purple|teal|turquoise|khaki|olive|red|orange|silver|gold)\b/gi;

export interface CategoryDecision {
  category: CategoryKey;
  /** which field decided: the leaf category, the category path (leaf first), a product name, nothing */
  from: "category" | "path" | "name" | "none";
}

/**
 * Category from the structured fields first — the leaf category, then the path from the leaf upwards (so
 * "Home & Kitchen/…/Sofas" is home, not kitchen) — and only then from the names, with colour / weight phrases
 * ("Light Grey", "Lightweight") removed.
 */
export function classifyCategory(
  source: Pick<ProductSource, "category" | "categoryPath" | "names">,
): CategoryDecision {
  const ruleFor = (text: string) => CATEGORY_RULES.find(([, re]) => re.test(text))?.[0];
  const leaf = ruleFor(source.category.replace(LIGHT_ADJECTIVE, " "));
  if (leaf) return { category: leaf, from: "category" };
  const segments = (source.categoryPath ?? "").split("/").filter(Boolean).reverse();
  for (const seg of segments) {
    const c = ruleFor(seg.replace(LIGHT_ADJECTIVE, " "));
    if (c) return { category: c, from: "path" };
  }
  const name = ruleFor(Object.values(source.names).join(" ").replace(LIGHT_ADJECTIVE, " "));
  return name ? { category: name, from: "name" } : { category: "other", from: "none" };
}

export function categoryOf(source: Pick<ProductSource, "category" | "categoryPath" | "names">): CategoryKey {
  return classifyCategory(source).category;
}

/**
 * The product itself is a light source (the studio puts a light inside it and the hooks may say it lights up):
 * a lighting category from the catalog structure, or one only named so but whose facts name a light source; a
 * home / other product only when its facts name a bulb. Accessory LEDs (a drill's work light) never count.
 */
export function emitsLightOf(
  source: Pick<ProductSource, "category" | "categoryPath" | "names" | "facts">,
): boolean {
  const { category, from } = classifyCategory(source);
  const facts = source.facts;
  if (category === "lighting")
    return (
      from === "category" ||
      from === "path" ||
      has(facts, /\b(bulbs?|led|lumens?|watts?|lamps?|leuchtmittel|glühbirne|bombillas?|żarów\w*)\b/i)
    );
  return (category === "home" || category === "other") && has(facts, /\b(bulbs?|leuchtmittel|bombillas?)\b/i);
}

/** Features a reel must not claim unless the facts say so (per category). */
const RISKY_FEATURES: Record<CategoryKey, string[]> = {
  lighting: [
    "dimmable",
    "smart / app control",
    "touch control",
    "remote control",
    "cordless / battery",
    "USB charging",
    "colour-changing",
    "adjustable height",
  ],
  tools: ["brushless", "battery included", "charger included", "torque figures", "waterproof"],
  electronics: [
    "waterproof",
    "battery life figures",
    "fast charging",
    "noise cancelling",
    "wireless charging",
  ],
  beauty: [
    "clinically proven",
    "SPF value",
    "dermatologist tested",
    "natural / organic",
    "results timeframes",
  ],
  home: ["solid wood", "handmade", "waterproof", "assembly-free"],
  kitchen: ["dishwasher safe", "non-stick", "oven safe", "BPA-free"],
  fashion: ["waterproof", "organic", "handmade"],
  other: ["warranty", "certification", "best-seller status"],
};

const has = (facts: readonly ProductFact[], re: RegExp) => facts.some((f) => re.test(f.text));

function point(text: string, factIds: string[]): LinkedPoint {
  return { text: text.slice(0, 200), factIds: factIds.slice(0, 6) };
}

/** Dominant colours of the main catalog photo (white studio background ignored), k-means in RGB, k=4. */
export async function catalogPalette(imagePath: string): Promise<string[]> {
  const px = await decodeRaw(imagePath, "scale=48:48:flags=area,format=rgb24");
  const pts: [number, number, number][] = [];
  for (let i = 0; i + 2 < px.length; i += 3) {
    const r = px[i]!;
    const g = px[i + 1]!;
    const b = px[i + 2]!;
    if (r > 232 && g > 232 && b > 232) continue; // background
    pts.push([r, g, b]);
  }
  if (pts.length < 8) return [];
  // deterministic init: points at evenly spaced luminance ranks
  const sorted = [...pts].sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  const k = 4;
  let centers = Array.from({ length: k }, (_, i) => sorted[Math.floor(((i + 0.5) / k) * sorted.length)]!);
  let counts = new Array<number>(k).fill(0);
  for (let iter = 0; iter < 12; iter++) {
    const sums = centers.map(() => [0, 0, 0]);
    counts = new Array<number>(k).fill(0);
    for (const p of pts) {
      let best = 0;
      let bd = Infinity;
      centers.forEach((c, j) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bd) {
          bd = d;
          best = j;
        }
      });
      sums[best]![0]! += p[0];
      sums[best]![1]! += p[1];
      sums[best]![2]! += p[2];
      counts[best]!++;
    }
    centers = centers.map((c, j) =>
      counts[j] ? (sums[j]!.map((s) => Math.round(s / counts[j]!)) as [number, number, number]) : c,
    );
  }
  const hex = (c: [number, number, number]) =>
    `#${c
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`;
  return centers
    .map((c, j) => ({ c, n: counts[j]! }))
    .filter((x) => x.n >= pts.length * 0.04)
    .sort((a, b) => b.n - a.n)
    .map((x) => hex(x.c));
}

export class DeterministicProductAnalyzer implements ProductAnalyzer {
  readonly name = "deterministic";
  readonly capability = "product_analysis" as const;
  readonly local = true;
  readonly model = DETERMINISTIC_ANALYZER_VERSION;

  available(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }

  estimateMicros(): number {
    return 0;
  }

  async analyze(source: ProductSource, ctx: CallContext): Promise<ProductProfile> {
    const t0 = Date.now();
    const facts = source.facts;
    const category = categoryOf(source);
    const concepts = detectConcepts(facts, category);
    const selling = concepts
      .filter((c) => c.concept.role === "selling")
      .map((c) => point(c.concept.en, c.factIds));
    const technical = concepts
      .filter((c) => c.concept.role === "technical")
      .map((c) => point(c.concept.en, c.factIds));
    for (const f of facts.filter((x) => x.kind === "dimension" && x.unit === "cm"))
      technical.push(point(f.text.replace(/\s*\(.*\)$/, ""), [f.id]));
    const usage = facts.filter((f) => f.kind === "usage" && f.locale === "en-US");
    for (const f of usage.slice(0, 2)) technical.push(point(f.text, [f.id]));

    const heightCm = facts.find((f) => f.id === "dim.height.cm")?.value;
    const widthCm = facts.find((f) => f.id === "dim.width.cm")?.value;
    // a light source is the product itself (lamps), not an accessory LED (a drill's work light, a charger LED)
    const emitsLight = emitsLightOf(source);
    const visual: string[] = [];
    if (has(facts, /walnut|walnuss|nogal/i)) visual.push("walnut wood base");
    if (has(facts, /brass|messing|latón/i))
      visual.push(has(facts, /curved|gebogen|curvado/i) ? "curved brass stem" : "brass details");
    if (has(facts, /fabric|stoff|tela/i)) visual.push(emitsLight ? "fabric drum shade" : "fabric");
    if (has(facts, /black|schwarz|negro/i)) visual.push("black upper rod");
    const opportunities: string[] = [];
    if (emitsLight)
      opportunities.push(
        "light switching on: glow through the shade (relight)",
        "warm evening interior with the lamp as the light source",
      );
    if (visual.some((v) => v.includes("walnut"))) opportunities.push("macro of the walnut grain on the base");
    if (visual.some((v) => v.includes("brass"))) opportunities.push("light sweep along the brass curve");
    opportunities.push("slow turntable to show the silhouette");

    const main = source.images.find((i) => i.role === "main") ?? source.images[0];
    const palette = main ? await catalogPalette(main.path).catch(() => []) : [];
    // "Rivet Table Lamp": brand + the catalog's own product noun (the leaf of its category path, singular — a
    // style word such as "Contemporary" is never a product name), else brand + type, else the cleaned-up name
    const type = facts.find((f) => f.id === "type.en-US")?.text;
    const leaf = source.categoryPath
      ? source.category.replace(/ies$/i, "y").replace(/(?<!s)s$/i, "")
      : undefined;
    const noun = leaf && classifyCategory({ category: leaf, names: {} }).from === "category" ? leaf : type;
    const shortName = (
      noun && source.brand
        ? `${source.brand} ${noun}`
        : (source.names["en-US"] ?? Object.values(source.names)[0] ?? source.id)
            .replace(/^amazon brand\s*[–-]\s*/i, "")
            .split(/\s+[-–]\s+/)[0]!
    ).slice(0, 60);
    const customers: Record<CategoryKey, string[]> = {
      lighting: [
        "home-decor lovers styling a living room or hallway",
        "mid-century / modern interior fans",
        "people looking for a design gift",
      ],
      tools: ["DIY home renovators", "tradespeople"],
      electronics: ["tech-savvy early adopters"],
      beauty: ["skincare-conscious adults"],
      home: ["people furnishing a home"],
      kitchen: ["home cooks"],
      fashion: ["style-conscious shoppers"],
      other: ["online shoppers comparing options"],
    };
    const profile = ProductProfile.parse({
      productId: source.id,
      sourceHash: sourceHash(source),
      category,
      shortName,
      visual_features: visual,
      selling_points: selling.slice(0, 10),
      technical_features: technical.slice(0, 12),
      likely_customer: customers[category],
      visual_opportunities: opportunities.slice(0, 8),
      risks: RISKY_FEATURES[category]
        .filter((r) => !has(facts, new RegExp(r.split(/[ /]/)[0]!, "i")))
        .map((r) => `do not claim "${r}" — not in the product facts`)
        .slice(0, 10),
      palette: palette.slice(0, 6),
      traits: {
        emitsLight,
        hasMovingParts: category === "tools" || has(facts, /motor|rotat|spin/i),
        hasScreen: category === "electronics" && has(facts, /\b(screen|display|bildschirm|écran)\b/i),
        tall: Boolean(heightCm && widthCm && heightCm / widthCm > 1.3),
      },
      analyzer: { provider: this.name, model: this.model, version: DETERMINISTIC_ANALYZER_VERSION },
    });
    ctx.tracker.compute({
      stage: "other",
      label: "product analysis (deterministic)",
      wallMs: Date.now() - t0,
      scope: ctx.scope,
    });
    return profile;
  }
}
