import path from "node:path";
import { runChain } from "../capabilities/chain.ts";
import type { CallContext, VisualQaProvider } from "../capabilities/types.ts";
import type { QaIssue, QaReport } from "../contracts/manifest.ts";
import type { CaptionTrack, ShotClip, TextElement, VoiceTrack } from "../contracts/media.ts";
import type { ReelPlan } from "../contracts/plan.ts";
import type { BrandProfile, PlatformProfile, Rect } from "../contracts/profiles.ts";
import type { BudgetGate } from "../cost/tracker.ts";
import { allRules, productRectAt, scoreReport } from "./checks.ts";
import { extractRepresentativeFrames, measureVideo } from "./measure.ts";
import { DeterministicVisualQaProvider } from "./visual.ts";

/**
 * Reel QA on the delivered MP4: technical measurements + plan-aware rules (product visibility, safe areas, text,
 * CTA, branding, disclosure, voice timing) + visual QA on 5 representative frames (Gemini when configured and
 * within budget, otherwise the deterministic frame checks). Returns the QaReport stored in the manifest.
 */

export interface ReelQaInput {
  videoPath: string;
  plan: ReelPlan;
  platform: PlatformProfile;
  clips: readonly ShotClip[];
  texts: readonly TextElement[];
  captions?: CaptionTrack;
  voice?: VoiceTrack;
  brand: BrandProfile;
  logoExpected: boolean;
  /** where the composer drew the logo (composeLocalized's logoBox): checked against the text panels */
  logoBox?: Rect;
  /** visual QA chain (API first); the deterministic provider is appended when missing */
  visualQa?: readonly VisualQaProvider[];
  budget: BudgetGate;
  ctx: CallContext;
  /** pass score (default 80) */
  threshold?: number;
}

/**
 * Where a delivered reel's QA frames go: one directory per variant, locale AND platform — the platforms of a
 * locale are different videos (layout, logo), and their manifests / contact sheets point at these frames.
 */
export function qaFrameDir(
  workDir: string,
  plan: Pick<ReelPlan, "metadata" | "language">,
  platformId: string,
) {
  return path.join(
    workDir,
    `qa-${plan.metadata.variantKey}-${plan.language}-${platformId}`.replace(/[^A-Za-z0-9._-]/g, "_"),
  );
}

export async function runReelQa(input: ReelQaInput): Promise<QaReport> {
  const t0 = Date.now();
  const { plan, ctx } = input;
  const tech = await measureVideo(input.videoPath, ctx.signal ? { signal: ctx.signal } : {});
  const frames = await extractRepresentativeFrames(
    input.videoPath,
    tech.durationMs || plan.durationMs,
    qaFrameDir(ctx.workDir, plan, input.platform.id),
    undefined,
    ctx.signal ? { signal: ctx.signal } : {},
  );
  const rules = allRules({
    tech,
    plan,
    platform: input.platform,
    clips: input.clips,
    texts: input.texts,
    ...(input.captions ? { captions: input.captions } : {}),
    ...(input.voice ? { voice: input.voice } : {}),
    brand: input.brand,
    logoExpected: input.logoExpected,
    ...(input.logoBox ? { logoBox: input.logoBox } : {}),
  });
  ctx.tracker.compute({ stage: "qa", label: "technical qa", wallMs: Date.now() - t0, scope: ctx.scope });

  const deterministic = new DeterministicVisualQaProvider(plan.resolution);
  const chain: VisualQaProvider[] = [
    ...(input.visualQa ?? []).filter((p) => p.name !== deterministic.name),
    deterministic,
  ];
  const cta = input.texts.find((t) => t.kind === "cta")?.text.replace(/\n/g, " ") ?? "";
  const req = {
    frames,
    productRects: frames.map((f) => productRectAt(plan, input.clips, f.atMs)),
    productName: plan.product.name,
    ctaText: cta,
    locale: plan.language,
  };
  const visual = await runChain({
    capability: "visual_qa",
    providers: chain,
    budget: input.budget,
    estimate: (p) => p.estimateMicros(req),
    run: (p) => p.assess(req, ctx),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const v = visual.result;
  const issues: QaIssue[] = [...rules.issues];
  if (visual.provider.name !== deterministic.name) {
    if (!v.productVisible)
      issues.push({
        code: "visual_product_not_visible",
        severity: "major",
        message: "visual QA: product not clearly visible",
      });
    if (!v.ctaReadable)
      issues.push({
        code: "visual_cta_unreadable",
        severity: "major",
        message: "visual QA: CTA not readable",
      });
  } else {
    for (const m of v.issues)
      issues.push({ code: "visual_frame", severity: "minor", message: m.slice(0, 400) });
  }
  const scored = scoreReport(issues, v, input.threshold);
  return {
    ...scored,
    checks: [
      ...rules.checks,
      { id: "visual_qa", passed: v.score >= 70, value: { provider: visual.provider.name, score: v.score } },
    ],
    issues,
    frames,
    visualQa: {
      provider: visual.provider.name,
      model: visual.provider.model,
      score: v.score,
      issues: v.issues,
      rerenderRequired: v.rerenderRequired,
    },
    retries: [],
  };
}
