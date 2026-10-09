import type { GoogleAI } from "@cre/providers";
import { z } from "zod";
import type { CallContext, ProductAnalyzer } from "../capabilities/types.ts";
import { ProductProfile, type ProductSource } from "../contracts/product.ts";
import { catalogPalette, categoryOf, sourceHash } from "./deterministic.ts";

/**
 * Multimodal product analysis with Gemini (cheap Flash-Lite, minimal thinking): catalog facts BY ID plus up to
 * three catalog photos at low media resolution → schema-validated JSON. Every selling point must cite fact ids
 * that exist; points citing unknown ids are dropped. Category, palette and traits stay deterministic.
 */

export const GEMINI_ANALYZER_PROMPT_VERSION = "gemini-analyzer/1";

const Point = z.object({ text: z.string().min(1).max(200), factIds: z.array(z.string()).min(1).max(6) });
export const AnalyzerAnswer = z.object({
  shortName: z.string().min(1).max(60),
  visual_features: z.array(z.string().max(80)).max(12),
  selling_points: z.array(Point).max(10),
  technical_features: z.array(Point).max(12),
  likely_customer: z.array(z.string().max(100)).max(6),
  visual_opportunities: z.array(z.string().max(120)).max(8),
  risks: z.array(z.string().max(160)).max(10),
});

const SYSTEM = [
  "You analyse a real product for a short sales video. Use ONLY the given facts and photos.",
  "Every selling point and technical feature must cite the ids of the facts that prove it.",
  "Never invent specifications, prices, certificates, reviews or features. List as risks the plausible claims",
  "a copywriter might make that the facts do NOT support (e.g. dimmable, smart, waterproof).",
  "visual_opportunities = what a 3D product studio can show well (light, materials, details, motion). English.",
].join(" ");

export class GeminiProductAnalyzer implements ProductAnalyzer {
  readonly name = "gemini";
  readonly capability = "product_analysis" as const;
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

  estimateMicros(source: ProductSource): number {
    const factTokens = Math.ceil(source.facts.reduce((s, f) => s + f.text.length + 12, 0) / 3.5);
    return this.ai.estimateGenerateMicros(this.model, 400 + factTokens + 3 * 280, 900);
  }

  async analyze(source: ProductSource, ctx: CallContext): Promise<ProductProfile> {
    const photos = [
      ...source.images.filter((i) => i.role === "main"),
      ...source.images.filter((i) => i.role === "lifestyle"),
      ...source.images.filter((i) => i.role !== "main" && i.role !== "lifestyle"),
    ].slice(0, 3);
    const facts = source.facts.map((f) => `${f.id} [${f.kind}, ${f.locale}]: ${f.text}`).join("\n");
    const res = await this.ai.generate({
      model: this.model,
      system: SYSTEM,
      parts: [
        {
          text: `Product ${source.id} (${source.brand}), category ${source.categoryPath ?? source.category}.\nFacts:\n${facts}`,
        },
        ...photos.map((p) => ({ file: p.path, mimeType: "image/jpeg" })),
      ],
      jsonSchema: z.toJSONSchema(AnalyzerAnswer),
      thinkingLevel: "minimal",
      mediaResolution: "low",
      maxOutputTokens: 1200,
      timeoutMs: 60_000,
      label: "reel.product_analysis",
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    ctx.tracker.record({
      capability: "product_analysis",
      category: "llm",
      provider: this.name,
      model: res.model,
      costMicros: res.costMicros,
      estimated: Boolean(res.costEstimated),
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens + res.usage.thoughtsTokens,
      latencyMs: res.latencyMs,
      scope: ctx.scope,
      note: GEMINI_ANALYZER_PROMPT_VERSION,
    });
    const a = AnalyzerAnswer.parse(res.json ?? JSON.parse(res.text));
    const known = new Set(source.facts.map((f) => f.id));
    const keep = (ps: z.infer<typeof Point>[]) =>
      ps
        .map((p) => ({ ...p, factIds: p.factIds.filter((id) => known.has(id)) }))
        .filter((p) => p.factIds.length > 0);
    const main = source.images.find((i) => i.role === "main") ?? source.images[0];
    const category = categoryOf(source);
    const hasText = (re: RegExp) => source.facts.some((f) => re.test(f.text));
    return ProductProfile.parse({
      productId: source.id,
      sourceHash: sourceHash(source),
      category,
      shortName: a.shortName,
      visual_features: a.visual_features,
      selling_points: keep(a.selling_points),
      technical_features: keep(a.technical_features),
      likely_customer: a.likely_customer,
      visual_opportunities: a.visual_opportunities,
      risks: a.risks,
      palette: main ? (await catalogPalette(main.path).catch(() => [])).slice(0, 6) : [],
      traits: {
        emitsLight: category === "lighting" || hasText(/\b(LED|bulb)\b/i),
        hasMovingParts: category === "tools" || hasText(/motor|rotat|spin/i),
        hasScreen: category === "electronics" && hasText(/\b(screen|display)\b/i),
        tall: false,
      },
      analyzer: { provider: this.name, model: res.model, version: GEMINI_ANALYZER_PROMPT_VERSION },
    });
  }
}
