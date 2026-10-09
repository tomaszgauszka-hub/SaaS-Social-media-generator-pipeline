import type { QaReport } from "../contracts/manifest.ts";
import type { ReelPlan } from "../contracts/plan.ts";

/**
 * Deterministic auto-retry: QA fix codes → a patched plan. No model. The factory re-renders only what the patch
 * changes (a reframed shot re-renders in Blender, a CTA extension re-times two shots, caption / loudness fixes
 * only re-run the localized pass).
 *
 *   reframe:<shot>:+fill | -fill   product framing ×1.15 / ×0.85 (bounded)
 *   reposition_captions            caption band 120 px up (bounded)
 *   extend_cta:<ms>                CTA window longer by taking the time from the previous shot (≥ 900 ms kept)
 *   renormalize                    1 dB more true-peak headroom
 */

const MIN_SHOT_MS = 900;

export function planRetry(report: QaReport, plan: ReelPlan): { fixes: string[]; patched: ReelPlan } {
  const codes = [
    ...new Set(report.issues.filter((i) => i.fix && i.severity !== "minor").map((i) => i.fix!)),
  ].sort();
  const p = structuredClone(plan);
  const applied: string[] = [];

  for (const code of codes) {
    const [kind, a, b] = code.split(":");
    switch (kind) {
      case "reframe": {
        const shot = p.shots.find((s) => s.id === a);
        if (!shot) break;
        const fill = Math.min(2.5, Math.max(0.25, shot.params.fill * (b === "+fill" ? 1.15 : 0.85)));
        if (Math.abs(fill - shot.params.fill) < 1e-6) break;
        shot.params.fill = Number(fill.toFixed(3));
        applied.push(code);
        break;
      }
      case "reposition_captions": {
        const cur = p.captions.offsetYPx ?? 0;
        if (cur <= -400) break;
        p.captions.offsetYPx = Math.max(-400, cur - 120);
        applied.push(code);
        break;
      }
      case "extend_cta": {
        const delta = Math.max(100, Number(a) || 0);
        const i = p.shots.findIndex(
          (s) => s.startMs <= p.cta.startMs && s.startMs + s.durationMs > p.cta.startMs,
        );
        const shot = p.shots[i];
        const prev = p.shots[i - 1];
        if (!shot || !prev || prev.durationMs - delta < MIN_SHOT_MS) break;
        prev.durationMs -= delta;
        shot.startMs -= delta;
        shot.durationMs += delta;
        p.cta.startMs = Math.max(0, p.cta.startMs - delta);
        p.structure = p.shots.map((s) => ({
          role: s.role,
          startMs: s.startMs,
          endMs: s.startMs + s.durationMs,
        }));
        applied.push(code);
        break;
      }
      case "renormalize": {
        const tp = p.render_profile.audio.truePeakDb;
        if (tp <= -9) break;
        p.render_profile.audio.truePeakDb = Math.max(-9, tp - 1);
        applied.push(code);
        break;
      }
      case undefined:
      default:
        break;
    }
  }
  return { fixes: applied, patched: applied.length ? p : plan };
}
