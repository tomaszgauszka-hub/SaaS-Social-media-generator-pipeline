import { measureText, textOverlayBounds, type Box } from "./ass.ts";
import type { VideoProject } from "./schema.ts";

/**
 * Layout validation used by automated QA: text/shape boxes outside the platform safe area, and text whose
 * longest line is wider than its allowed box (overflow after auto-fit).
 */
export interface LayoutViolation {
  id: string;
  kind: "outside_safe_area" | "text_overflow" | "text_too_small";
  message: string;
  box?: Box;
}

export function findLayoutViolations(project: VideoProject, tolerancePx = 6): LayoutViolation[] {
  const { width: W, height: H } = project.format;
  const sa = project.safeArea;
  const inside = (b: Box) =>
    b.x0 >= sa.left - tolerancePx &&
    b.x1 <= W - sa.right + tolerancePx &&
    b.y0 >= sa.top - tolerancePx &&
    b.y1 <= H - sa.bottom + tolerancePx;
  const violations: LayoutViolation[] = [];
  const minReadable = Math.round(W * 0.024);

  for (const t of project.texts) {
    const box = textOverlayBounds(t);
    if (!inside(box)) {
      violations.push({
        id: t.id,
        kind: "outside_safe_area",
        message: `Text "${t.text.slice(0, 40)}" leaves the safe area`,
        box,
      });
    }
    const widest = Math.max(
      ...t.text.split("\n").map((l) => measureText(t.uppercase ? l.toUpperCase() : l, t.fontSize, t.bold)),
    );
    if (widest > t.maxWidth + tolerancePx) {
      violations.push({
        id: t.id,
        kind: "text_overflow",
        message: `Text "${t.text.slice(0, 40)}" is wider than its box`,
        box,
      });
    }
    if (t.fontSize < minReadable) {
      violations.push({
        id: t.id,
        kind: "text_too_small",
        message: `Text "${t.text.slice(0, 40)}" is ${t.fontSize}px (min ${minReadable}px)`,
      });
    }
  }
  for (const s of project.shapes) {
    const box = {
      x0: s.x - s.width / 2,
      y0: s.y - s.height / 2,
      x1: s.x + s.width / 2,
      y1: s.y + s.height / 2,
    };
    if (!inside(box))
      violations.push({
        id: s.id,
        kind: "outside_safe_area",
        message: `Shape ${s.id} leaves the safe area`,
        box,
      });
  }
  if (project.subtitles?.enabled) {
    const fs = project.subtitles.fontSize;
    const box = {
      x0: sa.left,
      y0: project.subtitles.y - fs * 0.7,
      x1: W - sa.right,
      y1: project.subtitles.y + fs * 0.7,
    };
    if (!inside(box))
      violations.push({
        id: "subtitles",
        kind: "outside_safe_area",
        message: "Subtitles leave the safe area",
        box,
      });
  }
  return violations;
}
