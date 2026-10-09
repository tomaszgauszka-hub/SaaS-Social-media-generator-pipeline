import type { GoogleAI } from "@cre/providers";
import { z } from "zod";
import type {
  CallContext,
  VisualQaProvider,
  VisualQaRequest,
  VisualQaResult,
} from "../capabilities/types.ts";

/**
 * AI visual QA (optional, cheap): Gemini looks at ONLY the 5 representative frames at low media resolution and
 * answers a fixed rubric as schema-validated JSON. It never sees the plan, the repo or any secret; its answer is
 * data (a score and short notes) that can only lower the QA score or request a deterministic re-render.
 */

export const VisualQaAnswer = z.object({
  score: z.number().min(0).max(100),
  productVisible: z.boolean(),
  productCut: z.boolean(),
  ctaReadable: z.boolean(),
  professional: z.boolean(),
  artifacts: z.boolean(),
  issues: z.array(z.string().max(160)).max(6),
});
export type VisualQaAnswer = z.infer<typeof VisualQaAnswer>;

export const VISUAL_QA_PROMPT_VERSION = "visual-qa/1";

const SYSTEM = [
  "You are a strict quality reviewer of 9:16 product sales videos for social media.",
  "You receive representative frames (10/30/50/70/90 % of the video).",
  "Judge only what is visible: is the product clearly visible and recognisable, is it cut by the frame edges",
  "(intentional macro close-ups are fine), is the call-to-action text readable in the last frames, does it look",
  "professional (lighting, composition, no clutter), are there artefacts (garbled or overlapping text, render",
  "glitches, black or empty frames). Score 0-100 (85+ = ready to publish). Keep issues short and concrete.",
].join(" ");

/** tokens per image at low media resolution (Gemini 3 family) + rubric + answer */
const IMAGE_TOKENS_LOW = 280;

export class GeminiVisualQaProvider implements VisualQaProvider {
  readonly name = "gemini";
  readonly capability = "visual_qa" as const;
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

  estimateMicros(req: VisualQaRequest): number {
    return this.ai.estimateGenerateMicros(this.model, 450 + req.frames.length * IMAGE_TOKENS_LOW, 260);
  }

  async assess(req: VisualQaRequest, ctx: CallContext): Promise<VisualQaResult> {
    const res = await this.ai.generate({
      model: this.model,
      system: SYSTEM,
      parts: [
        {
          text:
            `Product: ${req.productName.slice(0, 120)}. Expected call-to-action text (${req.locale}): ` +
            `"${req.ctaText.slice(0, 80)}". Frames follow in order.`,
        },
        ...req.frames.map((f) => ({ file: f.path, mimeType: "image/jpeg" })),
      ],
      jsonSchema: z.toJSONSchema(VisualQaAnswer),
      thinkingLevel: "minimal",
      mediaResolution: "low",
      maxOutputTokens: 400,
      timeoutMs: 60_000,
      label: "reel.visual_qa",
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    ctx.tracker.record({
      capability: "visual_qa",
      category: "visual_qa",
      provider: this.name,
      model: res.model,
      costMicros: res.costMicros,
      estimated: Boolean(res.costEstimated),
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens + res.usage.thoughtsTokens,
      latencyMs: res.latencyMs,
      scope: ctx.scope,
      note: VISUAL_QA_PROMPT_VERSION,
    });
    const a = VisualQaAnswer.parse(res.json ?? JSON.parse(res.text));
    return {
      score: a.score,
      issues: a.issues,
      // only problems a deterministic re-render can address justify one
      rerenderRequired: a.productCut || !a.productVisible,
      productVisible: a.productVisible,
      productCut: a.productCut,
      ctaReadable: a.ctaReadable,
    };
  }
}
