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

export const DETERMINISTIC_ANALYZER_VERSION = "deterministic-analyzer/1";

export function sourceHash(source: ProductSource): string {
  return sha256Hex(stableStringify(source)).slice(0, 24);
}

const CATEGORY_RULES: [CategoryKey, RegExp][] = [
  ["lighting", /(lamp|light|lighting|leuchte|lampe|lámpara|lampada|luminaire|chandelier|sconce)/i],
  ["tools", /(drill|driver|saw|sander|grinder|tool|wrench|wkrętar|bohr|werkzeug|taladro)/i],
  ["beauty", /(cream|serum|sunscreen|lotion|cosmetic|beauty|skin|hair|makeup|lipstick)/i],
  ["kitchen", /(kitchen|cook|pan|pot|knife|blender|kettle|mug|cup|plate|küche|cocina)/i],
  ["electronics", /(phone|speaker|headphone|charger|camera|tablet|laptop|monitor|watch|electronic)/i],
  ["fashion", /(shirt|dress|shoe|boot|bag|jacket|jeans|hat|apparel|clothing)/i],
  ["home", /(chair|table|sofa|shelf|rug|pillow|vase|mirror|furniture|decor|home|bed|cabinet|stool)/i],
];

export function categoryOf(source: ProductSource): CategoryKey {
  const hay = [source.category, source.categoryPath ?? "", ...Object.values(source.names)].join(" ");
  return CATEGORY_RULES.find(([, re]) => re.test(hay))?.[0] ?? "other";
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
    const emitsLight = category === "lighting" || has(facts, /\b(LED|bulb|leuchtmittel|bombilla)\b/i);
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
    // "Rivet Table Lamp": brand + product type when the source has them, else the cleaned-up name
    const type = facts.find((f) => f.id === "type.en-US")?.text;
    const shortName = (
      type && source.brand
        ? `${source.brand} ${type}`
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
