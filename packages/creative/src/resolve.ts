import { G } from "./layouts.ts";
import {
  CREATIVE_MODEL_VERSION,
  type CreativeStoryboard,
  type FontAsset,
  type FontSpec,
  type LocalePack,
  type Overlay,
  type Rect,
  type RenderPlan,
  type ResolvedBeat,
  type ResolvedText,
  type TextColor,
  type TextElement,
  type TextRole,
} from "./model.ts";
import {
  checklistItemBox,
  counterLayout,
  listRows,
  specRowBoxes,
  stepRows,
  timerLayout,
} from "./overlay-geometry.ts";
import { checkSafeZones } from "./safe-zones.ts";
import { fitText, type TextMeasurer } from "./text-fit.ts";

/**
 * Storyboard + LocalePack → RenderPlan. Every visible string is measured with the real fonts (TextFitEngine) and
 * every resulting box is checked against the platform safe zones. Problems are returned as issues — the
 * resolver never silently shrinks text or moves it.
 */
export type IssueSeverity = "blocker" | "major" | "minor" | "info";

export interface ResolveIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  beatId?: string;
  slot?: string;
}

export interface ResolveOptions {
  fonts: FontAsset[];
  storyboardHash: string;
  /** resolved URLs for image/video media (vector media need none) */
  mediaUrls?: Record<string, string>;
}

export interface ResolveResult {
  plan: RenderPlan;
  issues: ResolveIssue[];
}

const BALANCED: ReadonlySet<TextRole> = new Set(["DISPLAY", "HEADLINE", "CTA", "STAT", "BODY"]);

interface FitInput {
  id: string;
  slot: string;
  role: TextRole;
  box: Rect;
  maxLines: number;
  align: "left" | "center" | "right";
  vAlign: "top" | "middle" | "bottom";
  animation: TextElement["animation"];
  delayMs: number;
  surface: TextElement["surface"];
  color: TextColor;
  exitBeforeEndMs: number;
  /** literal text (counter numbers) instead of a slot lookup */
  literal?: string;
  font?: FontSpec;
  sizes?: { min: number; max: number };
}

/** Bounds of the text actually drawn inside its box (for safe-zone checks). */
export function drawnBounds(t: Pick<ResolvedText, "box" | "align" | "vAlign" | "width" | "height">): Rect {
  const x =
    t.align === "left"
      ? t.box.x
      : t.align === "center"
        ? t.box.x + (t.box.w - t.width) / 2
        : t.box.x + t.box.w - t.width;
  const y =
    t.vAlign === "top"
      ? t.box.y
      : t.vAlign === "middle"
        ? t.box.y + (t.box.h - t.height) / 2
        : t.box.y + t.box.h - t.height;
  return { x, y, w: Math.max(1, t.width), h: Math.max(1, t.height) };
}

export function formatCounterValue(value: number, decimals: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function resolveRenderPlan(
  sb: CreativeStoryboard,
  pack: LocalePack,
  measurer: TextMeasurer,
  opts: ResolveOptions,
): ResolveResult {
  const issues: ResolveIssue[] = [];
  const style = sb.style;
  const locale = pack.locale;

  for (const slot of Object.keys(sb.textSlots)) {
    if (!(slot in pack.strings) || !pack.strings[slot]?.trim())
      issues.push({
        severity: "blocker",
        code: "MISSING_TEXT",
        message: `No ${locale} text for slot ${slot}`,
        slot,
      });
  }

  const resolveOne = (input: FitInput, beatId?: string): ResolvedText => {
    const value = input.literal ?? pack.strings[input.slot] ?? "";
    const font = input.font ?? style.fonts[input.role];
    const sizes = input.sizes ?? style.sizes[input.role];
    const fit = fitText(measurer, {
      text: value,
      font,
      box: { w: input.box.w, h: input.box.h },
      maxLines: input.maxLines,
      minSize: sizes.min,
      maxSize: sizes.max,
      balance: BALANCED.has(input.role),
      locale,
    });
    for (const issue of fit.issues) {
      issues.push({
        severity: issue.code === "MISSING_GLYPHS" || issue.code === "EMPTY_TEXT" ? "blocker" : "major",
        code: issue.code,
        message: `${input.slot}: ${issue.message}`,
        slot: input.slot,
        ...(beatId ? { beatId } : {}),
      });
    }
    return {
      id: input.id,
      slot: input.slot,
      role: input.role,
      box: input.box,
      align: input.align,
      vAlign: input.vAlign,
      animation: input.animation,
      delayMs: input.delayMs,
      surface: input.surface,
      color: input.color,
      exitBeforeEndMs: input.exitBeforeEndMs,
      font,
      fontSize: fit.fontSize,
      lineHeightPx: fit.lineHeightPx,
      lines: fit.lines,
      width: fit.width,
      height: fit.height,
      fits: fit.fits,
    };
  };

  const overlayFits = (o: Overlay, beatId: string): Record<string, ResolvedText> => {
    const out: Record<string, ResolvedText> = {};
    const add = (
      key: string,
      input: Omit<FitInput, "id" | "animation" | "surface" | "exitBeforeEndMs"> & Partial<FitInput>,
    ) => {
      out[key] = resolveOne(
        { animation: "none", surface: "none", exitBeforeEndMs: 0, ...input, id: key },
        beatId,
      );
    };
    switch (o.kind) {
      case "callout":
        add(`${o.id}:${o.textSlot}`, {
          slot: o.textSlot,
          role: "SPEC",
          box: o.label,
          maxLines: 2,
          align: o.side === "right" ? "left" : "right",
          vAlign: "middle",
          delayMs: o.delayMs,
          color: "ink",
        });
        break;
      case "measure":
        add(`${o.id}:${o.textSlot}`, {
          slot: o.textSlot,
          role: "SPEC",
          box: o.label,
          maxLines: 1,
          align: "center",
          vAlign: "middle",
          delayMs: o.delayMs,
          color: "ink",
        });
        break;
      case "badge":
        add(`${o.id}:${o.textSlot}`, {
          slot: o.textSlot,
          role: o.tone === "accent" && o.box.h >= 96 ? "CTA" : "CAPTION",
          // CTA buttons carry an arrow icon on the right
          box:
            o.tone === "accent" && o.box.h >= 96
              ? { x: o.box.x + 28, y: o.box.y + 8, w: o.box.w - 28 - 84, h: o.box.h - 16 }
              : { x: o.box.x + 24, y: o.box.y + 8, w: o.box.w - 48, h: o.box.h - 16 },
          maxLines: 1,
          align: "center",
          vAlign: "middle",
          delayMs: o.delayMs,
          color:
            o.tone === "accent"
              ? "accentInk"
              : o.tone === "surface"
                ? "surfaceInk"
                : o.tone === "dark"
                  ? "onMedia"
                  : "ink",
        });
        break;
      case "counter": {
        const geo = counterLayout(o);
        const number = formatCounterValue(o.to, o.decimals, locale);
        add(`${o.id}:number`, {
          slot: `${o.id}:number`,
          literal: number,
          role: "STAT",
          box: geo.number,
          maxLines: 1,
          align: o.style === "gauge" ? "center" : style.textAlign === "center" ? "center" : "left",
          vAlign: o.style === "gauge" ? "middle" : "top",
          delayMs: o.delayMs,
          color: "ink",
        });
        if (o.unitSlot) {
          // plain / bar: the unit reads with the number (≈40 % of its size), gauge: a label inside the dial
          const numberSize = out[`${o.id}:number`]?.fontSize ?? 160;
          const unitRole = o.style === "gauge" ? "SPEC" : "HEADLINE";
          add(`${o.id}:${o.unitSlot}`, {
            slot: o.unitSlot,
            role: unitRole,
            // units keep their case: Pa, mAh, kWh
            font: { ...style.fonts[unitRole], transform: "none" },
            box: o.style === "gauge" ? geo.unit : { ...geo.unit, h: Math.round(numberSize * 0.62) },
            maxLines: 1,
            align: o.style === "gauge" ? "center" : "left",
            vAlign: "top",
            delayMs: o.delayMs,
            color: "accent",
            ...(o.style === "gauge"
              ? {}
              : {
                  sizes: {
                    min: Math.max(36, Math.round(numberSize * 0.28)),
                    max: Math.round(numberSize * 0.42),
                  },
                }),
          });
        }
        break;
      }
      case "spec_list": {
        const rows = listRows(o.box, o.items.length);
        o.items.forEach((it, i) => {
          const b = specRowBoxes(rows[i]!);
          const delay = o.delayMs + i * o.staggerMs;
          add(`${o.id}:${it.labelSlot}`, {
            slot: it.labelSlot,
            role: "SPEC",
            box: b.label,
            maxLines: 1,
            align: "left",
            vAlign: "middle",
            delayMs: delay,
            color: "surfaceInk",
          });
          add(`${o.id}:${it.valueSlot}`, {
            slot: it.valueSlot,
            role: "SPEC",
            box: b.value,
            maxLines: 1,
            align: "right",
            vAlign: "middle",
            delayMs: delay,
            color: "surfaceInk",
          });
        });
        break;
      }
      case "checklist": {
        const rows = listRows(o.box, o.itemSlots.length);
        o.itemSlots.forEach((slot, i) => {
          add(`${o.id}:${slot}`, {
            slot,
            role: "BODY",
            box: checklistItemBox(rows[i]!).text,
            maxLines: 1,
            align: "left",
            vAlign: "middle",
            delayMs: o.delayMs + i * o.staggerMs,
            color: "surfaceInk",
          });
        });
        break;
      }
      case "steps": {
        const rows = stepRows(o.box, o.itemSlots.length);
        o.itemSlots.forEach((slot, i) => {
          add(`${o.id}:${slot}`, {
            slot,
            role: "BODY",
            box: rows[i]!.text,
            maxLines: 2,
            align: "left",
            vAlign: "top",
            delayMs: o.delayMs + i * o.staggerMs,
            color: "ink",
          });
        });
        break;
      }
      case "timer": {
        const geo = timerLayout(o);
        const s = Math.round(o.seconds);
        add(`${o.id}:digits`, {
          slot: `${o.id}:digits`,
          literal: `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`,
          role: "STAT",
          box: geo.digits,
          maxLines: 1,
          align: "left",
          vAlign: "middle",
          delayMs: o.delayMs,
          color: "onMedia",
          surface: "chip",
          sizes: { min: 60, max: 120 },
        });
        if (o.labelSlot)
          add(`${o.id}:${o.labelSlot}`, {
            slot: o.labelSlot,
            role: "CAPTION",
            box: geo.label,
            maxLines: 1,
            align: "left",
            vAlign: "bottom",
            delayMs: o.delayMs,
            color: "onMedia",
            surface: "chip",
          });
        break;
      }
      case "icon_chip":
        add(`${o.id}:${o.textSlot}`, {
          slot: o.textSlot,
          role: "BODY",
          box: { x: o.box.x + o.box.h + 4, y: o.box.y + 10, w: o.box.w - o.box.h - 28, h: o.box.h - 20 },
          maxLines: 1,
          align: "left",
          vAlign: "middle",
          delayMs: o.delayMs,
          color: o.tone === "accent" ? "accentInk" : o.tone === "dark" ? "onMedia" : "surfaceInk",
          sizes: { min: 30, max: Math.round(o.box.h * 0.42) },
        });
        break;
      case "slider":
      case "arrow":
      case "cursor":
      case "highlight":
      case "light_sweep":
      case "panel":
      case "particles":
        break;
    }
    return out;
  };

  let start = 0;
  const beats: ResolvedBeat[] = sb.beats.map((b) => {
    const texts = b.text.map((t) =>
      resolveOne(
        {
          id: t.id,
          slot: t.slot,
          role: t.role,
          box: t.box,
          maxLines: t.maxLines,
          align: t.align,
          vAlign: t.vAlign,
          animation: t.animation,
          delayMs: t.delayMs,
          surface: t.surface,
          color: t.color,
          exitBeforeEndMs: t.exitBeforeEndMs,
        },
        b.id,
      ),
    );
    const overlayTexts: Record<string, ResolvedText> = {};
    for (const o of b.overlays) Object.assign(overlayTexts, overlayFits(o, b.id));
    const strings: Record<string, string> = {};
    for (const o of b.overlays) {
      const slots = overlaySlots(o);
      for (const s of slots) if (pack.strings[s] !== undefined) strings[s] = pack.strings[s];
    }
    const resolved: ResolvedBeat = { ...b, startMs: start, texts, strings, overlayTexts };
    start += b.durationMs;
    return resolved;
  });
  const durationMs = start;

  let disclosure: ResolvedText | undefined;
  if (sb.global.disclosureSlot) {
    disclosure = resolveOne({
      id: "global.disclosure",
      slot: sb.global.disclosureSlot,
      role: "CAPTION",
      box: { x: G.L, y: G.DISCLOSURE_Y, w: 640, h: G.DISCLOSURE_H },
      maxLines: 1,
      align: "left",
      vAlign: "bottom",
      animation: "none",
      delayMs: 0,
      surface: "chip",
      color: "ink",
      exitBeforeEndMs: 0,
      sizes: { min: style.sizes.CAPTION.min, max: style.sizes.CAPTION.min + 4 },
    });
  }

  // safe zones: everything that carries information, as actually drawn
  const elements: { id: string; rect: Rect }[] = [];
  for (const b of beats) {
    for (const t of b.texts)
      if (t.lines.length) elements.push({ id: `${b.id}/${t.slot}`, rect: drawnBounds(t) });
    for (const [key, t] of Object.entries(b.overlayTexts))
      if (t.lines.length) elements.push({ id: `${b.id}/${key}`, rect: drawnBounds(t) });
    for (const o of b.overlays)
      if (o.kind === "badge" || o.kind === "icon_chip") elements.push({ id: `${b.id}/${o.id}`, rect: o.box });
  }
  if (disclosure) elements.push({ id: "global.disclosure", rect: drawnBounds(disclosure) });
  for (const v of checkSafeZones(elements, sb.platforms, sb.format)) {
    issues.push({
      severity: v.element.includes("button") || v.element.includes(".cta") ? "blocker" : "major",
      code: "SAFE_ZONE",
      message: `${v.element} overlaps ${v.platform} ${v.zone}`,
      beatId: v.element.split("/")[0]!,
    });
  }

  const media: RenderPlan["media"] = {};
  for (const m of sb.media)
    media[m.id] = { ...m, ...(opts.mediaUrls?.[m.id] ? { url: opts.mediaUrls[m.id] } : {}) };

  const plan: RenderPlan = {
    version: CREATIVE_MODEL_VERSION,
    storyboardId: sb.id,
    storyboardHash: opts.storyboardHash,
    locale,
    format: sb.format,
    durationMs,
    durationInFrames: Math.round((durationMs * sb.format.fps) / 1000),
    style,
    media,
    beats,
    global: {
      progressBar: sb.global.progressBar,
      ...(disclosure ? { disclosure } : {}),
      ...(sb.global.handle ? { handle: sb.global.handle } : {}),
      ...(sb.flags.placeholderMedia || sb.flags.demoOnly ? { demoLabel: "DEMO MEDIA · NOT PRODUCTION" } : {}),
    },
    audio: sb.audio,
    flags: sb.flags,
    fonts: opts.fonts,
  };
  return { plan, issues };
}

/** Slots referenced by an overlay. */
export function overlaySlots(o: Overlay): string[] {
  switch (o.kind) {
    case "callout":
    case "measure":
    case "badge":
    case "icon_chip":
      return [o.textSlot];
    case "counter":
      return [o.unitSlot, o.labelSlot].filter((s): s is string => Boolean(s));
    case "spec_list":
      return o.items.flatMap((i) => [i.labelSlot, i.valueSlot]);
    case "checklist":
    case "steps":
      return o.itemSlots;
    case "slider":
      return [o.beforeSlot, o.afterSlot].filter((s): s is string => Boolean(s));
    case "timer":
      return o.labelSlot ? [o.labelSlot] : [];
    case "arrow":
    case "cursor":
    case "highlight":
    case "light_sweep":
    case "panel":
    case "particles":
      return [];
  }
}
