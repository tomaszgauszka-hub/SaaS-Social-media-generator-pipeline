import { runFfmpeg } from "@cre/media";
import type {
  CallContext,
  VisualQaProvider,
  VisualQaRequest,
  VisualQaResult,
} from "../capabilities/types.ts";
import type { Rect } from "../contracts/profiles.ts";

/**
 * Local visual QA on the representative frames — FFmpeg statistics, no model:
 *   exposure (crushed / blown / flat frame), product region not blank (luma spread inside the product box),
 *   product region not soft (edge density inside the box).
 * It is the last provider of the visual_qa chain, so a visual verdict always exists at zero cost.
 */

export interface FrameStats {
  yavg: number;
  ylow: number;
  yhigh: number;
}

export function parseSignalstats(stderr: string): FrameStats {
  const get = (k: string) => {
    const m = new RegExp(`lavfi\\.signalstats\\.${k}=(-?[0-9.]+)`).exec(stderr);
    return m ? Number(m[1]) : NaN;
  };
  return { yavg: get("YAVG"), ylow: get("YLOW"), yhigh: get("YHIGH") };
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** crop expression for a px rect clamped to the frame (W×H) */
export function cropFor(r: Rect, W: number, H: number): string {
  const x = Math.max(0, Math.min(W - 2, Math.round(r.x)));
  const y = Math.max(0, Math.min(H - 2, Math.round(r.y)));
  const w = even(Math.min(W - x, r.w));
  const h = even(Math.min(H - y, r.h));
  return `crop=${w}:${h}:${x}:${y}`;
}

async function stats(file: string, vf: string, signal?: AbortSignal): Promise<FrameStats> {
  const { stderr } = await runFfmpeg(
    ["-i", file, "-vf", `${vf},signalstats,metadata=mode=print`, "-f", "null", "-"],
    {
      logLevel: "info",
      ...(signal ? { signal } : {}),
    },
  );
  return parseSignalstats(stderr);
}

export interface FrameVerdict {
  atMs: number;
  frame: FrameStats;
  product?: FrameStats & { edges: number };
  issues: { code: string; major: boolean; message: string }[];
}

/** Pure: thresholds on measured statistics (8-bit luma). */
export function judgeFrame(
  atMs: number,
  frame: FrameStats,
  product?: FrameStats & { edges: number },
): FrameVerdict {
  const issues: FrameVerdict["issues"] = [];
  const t = `${(atMs / 1000).toFixed(1)} s`;
  if (frame.yhigh < 40)
    issues.push({ code: "frame_crushed", major: true, message: `${t}: frame almost black` });
  if (frame.ylow > 228) issues.push({ code: "frame_blown", major: true, message: `${t}: frame blown out` });
  if (frame.yhigh - frame.ylow < 12)
    issues.push({ code: "frame_flat", major: true, message: `${t}: frame has no contrast` });
  if (product) {
    if (product.yhigh - product.ylow < 10)
      issues.push({
        code: "product_blank",
        major: true,
        message: `${t}: product region is flat (nothing rendered?)`,
      });
    else if (product.edges < 0.6)
      issues.push({
        code: "product_soft",
        major: false,
        message: `${t}: product region looks soft (edge density ${product.edges.toFixed(2)})`,
      });
  }
  return { atMs, frame, ...(product ? { product } : {}), issues };
}

export class DeterministicVisualQaProvider implements VisualQaProvider {
  readonly name = "deterministic";
  readonly capability = "visual_qa" as const;
  readonly local = true;
  readonly model = "ffmpeg-signalstats/1";
  lastVerdicts: FrameVerdict[] = [];

  constructor(private readonly frameSize = { width: 1080, height: 1920 }) {}

  available(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }

  estimateMicros(): number {
    return 0;
  }

  async assess(req: VisualQaRequest, ctx: CallContext): Promise<VisualQaResult> {
    const t0 = Date.now();
    const { width: W, height: H } = this.frameSize;
    const verdicts: FrameVerdict[] = [];
    for (const [i, f] of req.frames.entries()) {
      const frame = await stats(f.path, "null", ctx.signal);
      const rect = req.productRects?.[i];
      let product: (FrameStats & { edges: number }) | undefined;
      if (rect && rect.w > 8 && rect.h > 8) {
        const crop = cropFor(rect, W, H);
        const region = await stats(f.path, crop, ctx.signal);
        const edges = await stats(f.path, `${crop},format=gray,edgedetect=low=0.08:high=0.2`, ctx.signal);
        product = { ...region, edges: edges.yavg };
      }
      verdicts.push(judgeFrame(f.atMs, frame, product));
    }
    this.lastVerdicts = verdicts;
    const all = verdicts.flatMap((v) => v.issues);
    const score = Math.max(0, 100 - all.reduce((s, i) => s + (i.major ? 25 : 8), 0));
    ctx.tracker.compute({
      stage: "qa",
      label: "visual qa (deterministic)",
      wallMs: Date.now() - t0,
      scope: ctx.scope,
    });
    return {
      score,
      issues: all.map((i) => i.message),
      rerenderRequired: false,
      productVisible: !all.some((i) => i.code === "product_blank"),
      productCut: false,
      ctaReadable: true,
    };
  }
}
