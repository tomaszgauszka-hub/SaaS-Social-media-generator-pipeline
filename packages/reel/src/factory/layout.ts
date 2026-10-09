import { fitText, type FontSpec, type TextMeasurer } from "@cre/creative";
import type { TextElement } from "../contracts/media.ts";
import type { ReelPlan } from "../contracts/plan.ts";
import type { BrandProfile, PlatformProfile, Rect } from "../contracts/profiles.ts";

/**
 * Deterministic on-screen text layout for one locale: hook line, per-shot feature overlays, CTA headline +
 * button, disclosure. Sizes come from real font metrics (the same files libass draws), positions from the
 * platform's unsafe zones — the hook / overlay / CTA band sits under the platform top bar and above the caption
 * band, the disclosure sits bottom-left above the platform's own caption area.
 */

export interface LayoutIssue {
  slot: string;
  message: string;
}

const PANEL_PAD = 22;
const SIDE = 72;

export function bandsFor(platform: PlatformProfile): { topY: number; disclosureY: number; right: number } {
  const topBar = Math.max(
    0,
    ...platform.unsafe.filter((u) => u.rect.y === 0).map((u) => u.rect.y + u.rect.h),
  );
  const bottom = Math.min(
    platform.height,
    ...platform.unsafe
      .filter((u) => u.rect.y > platform.height / 2 && u.rect.w >= platform.width * 0.9)
      .map((u) => u.rect.y),
  );
  return { topY: topBar + 96, disclosureY: bottom - 74, right: platform.width - SIDE };
}

function spec(font: { family: string; weight: number }): FontSpec {
  return {
    family: font.family,
    weight: font.weight,
    style: "normal",
    letterSpacing: 0,
    transform: "none",
    lineHeight: 1.12,
  };
}

interface Fit {
  text: string;
  size: number;
  width: number;
  height: number;
  fits: boolean;
}

function fit(
  m: TextMeasurer,
  text: string,
  font: { family: string; weight: number },
  w: number,
  h: number,
  size: { min: number; max: number },
  maxLines: number,
  locale: string,
): Fit {
  const r = fitText(m, {
    text,
    font: spec(font),
    box: { w, h },
    maxLines,
    minSize: size.min,
    maxSize: size.max,
    balance: true,
    locale,
    step: 2,
  });
  return {
    text: r.lineTexts.join("\n") || text,
    size: r.fontSize,
    width: Math.ceil(r.width),
    height: Math.ceil(r.height),
    fits: r.fits,
  };
}

/** a text box of `f` centred horizontally at y (top) — the box is the text area; the panel adds padding */
function centred(f: Fit, frameW: number, y: number): Rect {
  return { x: Math.round((frameW - f.width) / 2), y, w: Math.max(1, f.width), h: Math.max(1, f.height) };
}

export function buildTextElements(opts: {
  plan: ReelPlan;
  brand: BrandProfile;
  platform: PlatformProfile;
  measurer: TextMeasurer;
}): { elements: TextElement[]; issues: LayoutIssue[] } {
  const { plan, brand, platform, measurer } = opts;
  const copy = plan.copy;
  const locale = copy.locale;
  const W = platform.width;
  const bands = bandsFor(platform);
  const maxW = bands.right - SIDE - 2 * PANEL_PAD;
  const display = { family: brand.fonts.display.family, file: brand.fonts.display.file };
  const body = { family: brand.fonts.body.family, file: brand.fonts.body.file };
  const darkPanel = { color: brand.colors.background, opacity: 0.62, radius: 26, padding: PANEL_PAD };
  const elements: TextElement[] = [];
  const issues: LayoutIssue[] = [];
  const text = (slot: string | undefined) => (slot ? copy.slots[slot]?.text : undefined);
  const check = (slot: string, f: Fit) => {
    if (!f.fits)
      issues.push({ slot, message: `"${f.text.replace(/\n/g, " ")}" does not fit at ${f.size}px` });
  };

  // hook — the first words of the reel, on the opening shot
  const hook = text("hook");
  const first = plan.shots[0];
  if (hook && first) {
    const f = fit(measurer, hook, brand.fonts.display, maxW, 250, { min: 54, max: 88 }, 2, locale);
    check("hook", f);
    elements.push({
      id: "hook",
      kind: "hook",
      text: f.text,
      startMs: 150,
      endMs: Math.min(first.startMs + first.durationMs - 120, 3200),
      box: centred(f, W, bands.topY),
      align: "center",
      fontSizePx: f.size,
      font: display,
      color: brand.colors.text,
      panel: darkPanel,
    });
  }

  // per-shot feature overlays (never on the hook shot, never during the CTA)
  for (const shot of plan.shots) {
    const value = text(shot.overlaySlot);
    if (!value || !shot.overlaySlot || (hook && shot === first)) continue;
    const start = shot.startMs + 260;
    const end = Math.min(shot.startMs + shot.durationMs - 160, plan.cta.startMs - 80);
    if (end - start < 700) continue;
    const f = fit(measurer, value, brand.fonts.body, maxW, 200, { min: 42, max: 62 }, 2, locale);
    check(shot.overlaySlot, f);
    elements.push({
      id: shot.overlaySlot,
      kind: "overlay",
      text: f.text,
      startMs: start,
      endMs: end,
      box: centred(f, W, bands.topY),
      align: "center",
      fontSizePx: f.size,
      font: body,
      color: brand.colors.text,
      panel: darkPanel,
    });
  }

  // CTA headline + button
  const cta = text(plan.cta.slot);
  if (cta) {
    const f = fit(measurer, cta, brand.fonts.display, maxW, 230, { min: 52, max: 80 }, 2, locale);
    check(plan.cta.slot, f);
    const box = centred(f, W, bands.topY);
    elements.push({
      id: "cta",
      kind: "cta",
      text: f.text,
      startMs: plan.cta.startMs,
      endMs: plan.cta.endMs,
      box,
      align: "center",
      fontSizePx: f.size,
      font: display,
      color: brand.colors.text,
      panel: darkPanel,
    });
    const button = text(plan.cta.buttonSlot);
    if (button) {
      const b = fit(measurer, button, brand.fonts.display, 640, 70, { min: 36, max: 50 }, 1, locale);
      check(plan.cta.buttonSlot, b);
      elements.push({
        id: "button",
        kind: "button",
        text: b.text,
        startMs: Math.min(plan.cta.startMs + 350, plan.cta.endMs - 600),
        endMs: plan.cta.endMs,
        box: centred(b, W, box.y + box.h + PANEL_PAD * 2 + 40),
        align: "center",
        fontSizePx: b.size,
        font: display,
        color: brand.colors.primary,
        panel: { color: brand.colors.accent, opacity: 1, radius: 40, padding: 26 },
      });
    }
  }

  // disclosure — the whole reel, small, bottom-left
  const disclosure = text(plan.branding.disclosureSlot);
  if (disclosure && plan.branding.disclosureSlot) {
    const f = fit(measurer, disclosure, brand.fonts.body, 620, 40, { min: 24, max: 30 }, 1, locale);
    check(plan.branding.disclosureSlot, f);
    elements.push({
      id: "disclosure",
      kind: "disclosure",
      text: f.text,
      startMs: 0,
      endMs: plan.durationMs,
      box: { x: SIDE - 24, y: bands.disclosureY, w: Math.max(1, f.width), h: Math.max(1, f.height) },
      align: "left",
      fontSizePx: f.size,
      font: body,
      color: brand.colors.text,
      panel: { color: "#000000", opacity: 0.45, radius: 14, padding: 12 },
    });
  }
  return { elements, issues };
}
