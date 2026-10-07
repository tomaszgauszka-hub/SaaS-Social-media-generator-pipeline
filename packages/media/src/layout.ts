import { fitText, measureText, sanitizeAssText } from "./ass.ts";
import type {
  Background,
  BrandStyle,
  Format,
  ImageLayer,
  MotionType,
  SafeArea,
  Scene,
  ShapeOverlay,
  SubtitleWord,
  TextOverlay,
  TransitionType,
  VideoProject,
} from "./schema.ts";
import {
  contrastRatio,
  getTemplate,
  luminance,
  mixHex,
  readableOn,
  type TemplatePreset,
} from "./templates.ts";
import { computeTimeline, textWindow } from "./timeline.ts";

/**
 * Storyboard = semantic description of a video (what each scene says and shows).
 * `layoutStoryboard` turns it into a concrete VideoProject (positions, sizes, animations) using a template.
 */
export type StoryboardSceneKind =
  | "HOOK"
  | "PROBLEM"
  | "PRODUCT"
  | "AI_SHOT"
  | "DEMO"
  | "BENEFITS"
  | "COMPARISON"
  | "OFFER"
  | "CTA"
  | "GENERIC";

export interface StoryboardVisual {
  /**
   * image   — full-bleed still (generated scene, stock, screenshot)
   * video   — full-bleed clip (AI image-to-video shot)
   * product — product shot (cut-out or photo) on a branded backdrop (optional `src` image backdrop)
   * card    — typographic card on an animated brand gradient
   */
  type: "image" | "video" | "product" | "card";
  src?: string;
  productSrc?: string;
  motion?: MotionType;
}

export interface StoryboardScene {
  id: string;
  kind: StoryboardSceneKind;
  durationMs: number;
  headline?: string;
  body?: string;
  bullets?: string[];
  visual: StoryboardVisual;
  transition?: TransitionType;
}

export interface Storyboard {
  templateKey: string;
  format: Format;
  safeArea: SafeArea;
  brand: BrandStyle;
  scenes: StoryboardScene[];
  cta?: { headline: string; button: string; subtext?: string };
  /** on-screen disclosure, visible for the whole video */
  disclosure?: { text: string };
  /** verified price only */
  priceBadge?: { text: string };
  productLabel?: string;
  subtitles?: { words: SubtitleWord[] };
  audio?: { musicSrc?: string; voiceover?: { src: string; startMs: number }; transitionSfxSrc?: string };
  logoSrc?: string;
  progressBar?: boolean;
  output?: { crf?: number; preset?: string };
}

export interface LayoutContext {
  t: TemplatePreset;
  W: number;
  H: number;
  u: number;
  cx: number;
  contentW: number;
  safe: SafeArea;
  lanes: { top: number; headline: number; middle: number; lower: number; caption: number };
  highlight: string;
}

function scaleSafeArea(sa: SafeArea, format: Format): SafeArea {
  // Safe areas are specified for 1080×1920; scale proportionally to other sizes.
  const sx = format.width / 1080;
  const sy = format.height / 1920;
  return {
    top: Math.round(sa.top * sy),
    bottom: Math.round(sa.bottom * sy),
    left: Math.round(sa.left * sx),
    right: Math.round(sa.right * sx),
  };
}

export function createLayoutContext(
  sb: Pick<Storyboard, "templateKey" | "format" | "safeArea" | "brand">,
): LayoutContext {
  const t = getTemplate(sb.templateKey);
  const W = sb.format.width;
  const H = sb.format.height;
  const u = W / 1080;
  const safe = scaleSafeArea(sb.safeArea, sb.format);
  const contentW = W - safe.left - safe.right;
  const contentH = H - safe.top - safe.bottom;
  const highlight =
    luminance(sb.brand.primary) >= luminance(sb.brand.accent) ? sb.brand.primary : sb.brand.accent;
  return {
    t,
    W,
    H,
    u,
    safe,
    cx: safe.left + contentW / 2,
    contentW,
    lanes: {
      top: safe.top + 70 * u,
      headline: safe.top + contentH * 0.28,
      middle: safe.top + contentH * 0.53,
      lower: safe.top + contentH * 0.8,
      caption: H - safe.bottom - 80 * u,
    },
    highlight,
  };
}

function backgroundFor(s: StoryboardScene, sb: Storyboard, L: LayoutContext): Background {
  const hasText = Boolean(s.headline || s.body || s.bullets?.length);
  const motion = { type: s.visual.motion ?? L.t.motion.image, intensity: L.t.motion.intensity };
  switch (s.visual.type) {
    case "image":
      if (!s.visual.src) break;
      return { type: "image", src: s.visual.src, motion, blur: 0, darken: hasText ? L.t.darkenImages : 0.1 };
    case "video":
      if (!s.visual.src) break;
      return { type: "video", src: s.visual.src, blur: 0, darken: hasText ? L.t.darkenImages * 0.6 : 0 };
    case "product":
      if (s.visual.src) {
        return {
          type: "image",
          src: s.visual.src,
          motion: { type: "zoom_in", intensity: 0.06 },
          blur: s.visual.src === s.visual.productSrc ? 40 : 0,
          darken: 0.2,
        };
      }
      return {
        type: "gradient",
        colors: [
          mixHex(sb.brand.background, sb.brand.primary, 0.25),
          mixHex(sb.brand.background, "#000000", 0.2),
        ],
        animated: true,
      };
    case "card":
      break;
  }
  return {
    type: "gradient",
    colors: [sb.brand.primary, mixHex(sb.brand.accent, "#000000", 0.25)],
    animated: true,
  };
}

interface TextPalette {
  color: string;
  outlineColor: string;
  accent: string;
  accentOutline: string;
}

/**
 * Text colours per background. Text is always white with a dark outline (the most legible social style);
 * highlighted words use the brightest brand colour on dark backgrounds and invert (dark fill, white outline)
 * on bright brand gradients where a brand-coloured word would disappear.
 */
function paletteFor(bg: Background, brand: BrandStyle, L: LayoutContext): TextPalette {
  if (bg.type === "gradient" || bg.type === "color") {
    const mid = bg.type === "gradient" ? mixHex(bg.colors[0], bg.colors[1], 0.5) : bg.color;
    const outlineColor = mixHex(mid, "#000000", 0.7);
    if (luminance(mid) > 0.18) {
      return { color: "#FFFFFF", outlineColor, accent: "#111111", accentOutline: "#FFFFFF" };
    }
    const candidates = [brand.primary, brand.accent, "#FFD60A"];
    const accent = candidates.reduce((best, c) =>
      contrastRatio(c, mid) > contrastRatio(best, mid) ? c : best,
    );
    return { color: "#FFFFFF", outlineColor, accent, accentOutline: outlineColor };
  }
  return { color: "#FFFFFF", outlineColor: "#000000", accent: L.highlight, accentOutline: "#000000" };
}

interface TextArgs {
  id: string;
  text: string;
  style: TextOverlay["style"];
  x: number;
  y: number;
  align?: TextOverlay["align"];
  maxWidth: number;
  sizeRatio: number;
  minRatio: number;
  maxLines: number;
  uppercase: boolean;
  outlineRatio: number;
  shadow: number;
  animation: TextOverlay["animation"];
  startMs: number;
  endMs: number;
  color: string;
  outlineColor: string;
  accent: string;
  accentOutline?: string;
  bold?: boolean;
  /** vertical anchor: the block's top edge instead of its centre */
  anchorTop?: boolean;
}

/** Fit + position a text block; returns the overlay and its pixel height. */
function placeText(a: TextArgs, L: LayoutContext): { overlay: TextOverlay; height: number } {
  const clean = sanitizeAssText(a.text);
  const measureSource = a.uppercase ? clean.toUpperCase() : clean;
  const fit = fitText(measureSource, {
    maxWidth: a.maxWidth,
    maxLines: a.maxLines,
    fontSize: Math.round(a.sizeRatio * L.W),
    minFontSize: Math.round(a.minRatio * L.W),
    bold: a.bold ?? true,
  });
  // Line breaks were computed on the rendered form (possibly uppercase); apply the same word breaks to the
  // original text so the ASS renderer reproduces exactly the measured lines.
  const words = clean.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cursor = 0;
  for (const measuredLine of fit.lines) {
    const count = measuredLine.split(/\s+/).filter(Boolean).length;
    lines.push(words.slice(cursor, cursor + count).join(" "));
    cursor += count;
  }
  if (cursor < words.length) lines.push(words.slice(cursor).join(" "));
  const height = fit.height;
  const y = a.anchorTop ? a.y + height / 2 : a.y;
  return {
    overlay: {
      id: a.id,
      text: lines.join("\n"),
      style: a.style,
      x: a.x,
      y,
      align: a.align ?? "center",
      maxWidth: a.maxWidth,
      fontSize: fit.fontSize,
      color: a.color,
      accentColor: a.accent,
      ...(a.accentOutline ? { accentOutlineColor: a.accentOutline } : {}),
      outlineColor: a.outlineColor,
      outline: Math.round(a.outlineRatio * L.W),
      shadow: a.shadow,
      bold: a.bold ?? true,
      uppercase: a.uppercase,
      animation: a.animation,
      startMs: a.startMs,
      endMs: a.endMs,
      layer: 3,
    },
    height,
  };
}

/** Product image box for PRODUCT/OFFER scenes. */
function productLayer(
  src: string,
  L: LayoutContext,
  s: StoryboardScene,
  centerY: number,
  heightRatio: number,
): ImageLayer {
  return {
    type: "image",
    src,
    x: L.cx,
    y: centerY,
    width: L.contentW * 0.82,
    height: (L.H - L.safe.top - L.safe.bottom) * heightRatio,
    enter: s.kind === "HOOK" ? "rise" : "slide_up",
    enterAtMs: 120,
    enterDurationMs: 520,
    float: L.t.motion.productFloat,
    shadow: true,
    driftX: 0,
  };
}

export function layoutStoryboard(sb: Storyboard): VideoProject {
  const L = createLayoutContext(sb);
  const { t, W, u, cx, contentW } = L;
  const textMaxW = contentW * 0.95;
  const hasSubs = Boolean(sb.subtitles && sb.subtitles.words.length > 0);

  const scenes: Scene[] = sb.scenes.map((s, i) => {
    const background = backgroundFor(s, sb, L);
    const layers: ImageLayer[] = [];
    if (s.visual.type === "product" && s.visual.productSrc) {
      const centerY = s.kind === "HOOK" ? L.lanes.lower - 40 * u : L.lanes.middle + 20 * u;
      layers.push(productLayer(s.visual.productSrc, L, s, centerY, s.kind === "HOOK" ? 0.36 : 0.46));
    }
    const isCta = s.kind === "CTA";
    return {
      id: s.id,
      kind: s.kind,
      durationMs: s.durationMs,
      background,
      layers,
      transitionIn:
        i === 0
          ? { type: "cut", durationMs: 0 }
          : {
              type: s.transition ?? (isCta ? t.transition.ctaType : t.transition.type),
              durationMs: t.transition.durationMs,
            },
      vignette: t.vignette && (background.type === "image" || background.type === "video"),
    };
  });

  const timeline = computeTimeline(scenes);
  const texts: TextOverlay[] = [];
  const shapes: ShapeOverlay[] = [];

  sb.scenes.forEach((s, i) => {
    const scene = scenes[i]!;
    const win = textWindow(timeline, i);
    const palette = paletteFor(scene.background, sb.brand, L);
    const base = {
      color: palette.color,
      outlineColor: palette.outlineColor,
      accent: palette.accent,
      accentOutline: palette.accentOutline,
      startMs: win.startMs + 60,
      endMs: win.endMs,
    };
    const headlineArgs = {
      ...base,
      style: "headline" as const,
      maxWidth: textMaxW,
      sizeRatio: t.headline.sizeRatio,
      minRatio: t.headline.minRatio,
      maxLines: t.headline.maxLines,
      uppercase: t.headline.uppercase,
      outlineRatio: t.headline.outlineRatio,
      shadow: t.headline.shadow,
      animation: t.headline.animation,
    };
    const bodyArgs = {
      ...base,
      style: "body" as const,
      maxWidth: textMaxW,
      sizeRatio: t.body.sizeRatio,
      minRatio: t.body.minRatio,
      maxLines: t.body.maxLines,
      uppercase: false,
      outlineRatio: t.body.outlineRatio,
      shadow: t.headline.shadow,
      animation: t.body.animation,
      startMs: base.startMs + 350,
    };

    if (s.kind === "CTA") {
      const ctaHeadline = s.headline ?? sb.cta?.headline ?? "";
      let y = L.lanes.headline;
      if (ctaHeadline) {
        const h = placeText(
          {
            ...headlineArgs,
            id: `${s.id}-headline`,
            text: ctaHeadline,
            x: cx,
            y,
            sizeRatio: t.cta.sizeRatio,
            animation: t.cta.animation,
          },
          L,
        );
        texts.push(h.overlay);
        y += h.height / 2 + 140 * u;
      }
      const buttonText = sb.cta?.button ?? "Link in bio";
      const btnFont = Math.round(t.cta.buttonTextRatio * W);
      const btnW = Math.min(contentW * 0.9, measureText(buttonText, btnFont) + 140 * u);
      const btnH = btnFont * 2.3;
      const btnColor = ctaButtonColor(scene.background, sb.brand);
      const btnText = readableOn(btnColor);
      const btnY = Math.max(y + btnH / 2, L.lanes.middle + 60 * u);
      shapes.push({
        id: `${s.id}-button`,
        type: "rounded_rect",
        x: cx,
        y: btnY,
        width: btnW,
        height: btnH,
        radius: btnH / 2,
        color: btnColor,
        opacity: 1,
        animation: "pop",
        startMs: base.startMs + 250,
        endMs: base.endMs,
        layer: 2,
      });
      texts.push(
        placeText(
          {
            ...bodyArgs,
            id: `${s.id}-button-text`,
            text: buttonText,
            x: cx,
            y: btnY,
            maxWidth: btnW - 60 * u,
            sizeRatio: t.cta.buttonTextRatio,
            minRatio: t.cta.buttonTextRatio * 0.7,
            maxLines: 1,
            color: btnText,
            outlineColor: btnColor,
            outlineRatio: 0,
            shadow: 0,
            animation: "pop",
            startMs: base.startMs + 250,
          },
          L,
        ).overlay,
      );
      if (sb.cta?.subtext) {
        texts.push(
          placeText(
            {
              ...bodyArgs,
              id: `${s.id}-subtext`,
              text: sb.cta.subtext,
              x: cx,
              y: btnY + btnH / 2 + 70 * u,
              sizeRatio: t.body.sizeRatio * 0.72,
              minRatio: t.body.minRatio * 0.72,
              maxLines: 2,
              animation: "fade",
              startMs: base.startMs + 600,
            },
            L,
          ).overlay,
        );
      }
      return;
    }

    if (s.kind === "BENEFITS" || s.kind === "COMPARISON") {
      let y = L.lanes.top + 60 * u;
      if (s.headline) {
        const h = placeText(
          {
            ...headlineArgs,
            id: `${s.id}-headline`,
            text: s.headline,
            x: cx,
            y,
            anchorTop: true,
            maxLines: 2,
          },
          L,
        );
        texts.push(h.overlay);
        y += h.height + 90 * u;
      }
      (s.bullets ?? []).slice(0, 4).forEach((bullet, k) => {
        const b = placeText(
          {
            ...bodyArgs,
            id: `${s.id}-bullet-${k}`,
            text: `${t.list.bullet} ${bullet}`,
            x: L.safe.left + 30 * u,
            y,
            align: "left",
            maxWidth: contentW - 60 * u,
            sizeRatio: t.list.sizeRatio,
            maxLines: 2,
            anchorTop: true,
            animation: t.list.animation,
            startMs: base.startMs + 300 + k * t.list.staggerMs,
          },
          L,
        );
        texts.push(b.overlay);
        y += b.height + 70 * u;
      });
      return;
    }

    // HOOK, PROBLEM, PRODUCT, AI_SHOT, DEMO, OFFER, GENERIC
    const isProduct = s.visual.type === "product";
    const headlineY = isProduct && s.kind !== "HOOK" ? L.lanes.top + 40 * u : L.lanes.headline;
    if (s.headline) {
      const h = placeText(
        {
          ...headlineArgs,
          id: `${s.id}-headline`,
          text: s.headline,
          x: cx,
          y: headlineY,
          anchorTop: isProduct && s.kind !== "HOOK",
          maxLines: isProduct ? 3 : t.headline.maxLines,
          animation: s.kind === "HOOK" ? t.headline.animation : "slide_up",
        },
        L,
      );
      texts.push(h.overlay);
      if (s.body && !isProduct) {
        texts.push(
          placeText(
            {
              ...bodyArgs,
              id: `${s.id}-body`,
              text: s.body,
              x: cx,
              y: headlineY + h.height / 2 + 60 * u,
              anchorTop: true,
            },
            L,
          ).overlay,
        );
      }
    } else if (s.body) {
      texts.push(
        placeText({ ...bodyArgs, id: `${s.id}-body`, text: s.body, x: cx, y: headlineY }, L).overlay,
      );
    }

    if (isProduct && s.kind !== "HOOK") {
      if (sb.productLabel) {
        const labelFont = Math.round(t.badge.sizeRatio * W);
        const labelY = hasSubs ? L.lanes.lower - 40 * u : L.lanes.lower + 20 * u;
        const label = placeText(
          {
            ...bodyArgs,
            id: `${s.id}-label`,
            text: sb.productLabel,
            x: cx,
            y: labelY,
            maxWidth: contentW * 0.86,
            sizeRatio: t.badge.sizeRatio,
            minRatio: t.badge.sizeRatio * 0.7,
            maxLines: 2,
            color: readableOn(sb.brand.primary),
            outlineColor: sb.brand.primary,
            outlineRatio: 0,
            shadow: 0,
            animation: "fade",
            startMs: base.startMs + 450,
          },
          L,
        );
        const labelW = Math.min(contentW * 0.92, measureLongestLine(label.overlay) + 70 * u);
        shapes.push({
          id: `${s.id}-label-bg`,
          type: "rounded_rect",
          x: cx,
          y: labelY,
          width: labelW,
          height: label.height + labelFont * 0.9,
          radius: 22 * u,
          color: sb.brand.primary,
          opacity: 0.95,
          animation: "fade",
          startMs: base.startMs + 450,
          endMs: base.endMs,
          layer: 2,
        });
        texts.push(label.overlay);
      }
      if (sb.priceBadge && (s.kind === "PRODUCT" || s.kind === "OFFER")) {
        const badgeFont = Math.round(t.badge.sizeRatio * W);
        const badgeW = measureText(sb.priceBadge.text, badgeFont) + 60 * u;
        const badgeH = badgeFont * 1.9;
        const bx = W - L.safe.right - badgeW / 2 - 10 * u;
        const by = L.lanes.middle - (L.H - L.safe.top - L.safe.bottom) * 0.2;
        shapes.push({
          id: `${s.id}-price-bg`,
          type: "rounded_rect",
          x: bx,
          y: by,
          width: badgeW,
          height: badgeH,
          radius: badgeH / 2,
          color: sb.brand.accent,
          opacity: 1,
          animation: "pop",
          startMs: base.startMs + 700,
          endMs: base.endMs,
          layer: 4,
        });
        texts.push({
          id: `${s.id}-price`,
          text: sanitizeAssText(sb.priceBadge.text),
          style: "badge",
          x: bx,
          y: by,
          align: "center",
          maxWidth: badgeW,
          fontSize: badgeFont,
          color: readableOn(sb.brand.accent),
          accentColor: readableOn(sb.brand.accent),
          outlineColor: sb.brand.accent,
          outline: 0,
          shadow: 0,
          bold: true,
          uppercase: false,
          animation: "pop",
          startMs: base.startMs + 700,
          endMs: base.endMs,
          layer: 5,
        });
      }
    }
  });

  if (sb.disclosure?.text) {
    texts.push({
      id: "disclosure",
      text: sanitizeAssText(sb.disclosure.text),
      style: "disclosure",
      x: L.safe.left,
      y: L.safe.top + Math.round(t.disclosure.sizeRatio * W * 0.9),
      align: "left",
      maxWidth: contentW,
      fontSize: Math.round(t.disclosure.sizeRatio * W),
      color: "#FFFFFF",
      accentColor: "#FFFFFF",
      outlineColor: "#000000",
      outline: Math.max(1, Math.round(2 * u)),
      shadow: 0,
      bold: true,
      uppercase: false,
      animation: "none",
      startMs: 0,
      endMs: timeline.totalMs,
      layer: 6,
    });
  }

  const sfx: VideoProject["audio"]["sfx"] = [];
  if (sb.audio?.transitionSfxSrc) {
    for (const w of timeline.windows.slice(1)) {
      if (w.transitionMs > 0)
        sfx.push({ src: sb.audio.transitionSfxSrc, atMs: Math.max(0, w.startMs - 60), volume: 0.35 });
    }
  }

  const hook = timeline.windows[0];
  return {
    version: 1,
    templateKey: t.key,
    format: sb.format,
    safeArea: L.safe,
    brand: sb.brand,
    scenes,
    texts,
    shapes,
    ...(hasSubs && sb.subtitles
      ? {
          subtitles: {
            enabled: true,
            style: t.subtitles.style,
            words: sb.subtitles.words,
            y: L.lanes.caption,
            fontSize: Math.round(t.subtitles.sizeRatio * W),
            color: "#FFFFFF",
            highlightColor: L.highlight,
            outlineColor: "#000000",
            maxWordsPerGroup: t.subtitles.maxWords,
            maxCharsPerGroup: t.subtitles.maxChars,
          },
        }
      : {}),
    audio: {
      ...(sb.audio?.musicSrc
        ? { music: { src: sb.audio.musicSrc, volume: sb.audio.voiceover ? 0.2 : 0.32, duck: true } }
        : {}),
      ...(sb.audio?.voiceover
        ? { voiceover: { src: sb.audio.voiceover.src, volume: 1, startMs: sb.audio.voiceover.startMs } }
        : {}),
      sfx,
      targetLufs: -14,
    },
    ...(sb.progressBar !== false
      ? { progressBar: { enabled: true, color: L.highlight, height: Math.max(4, Math.round(10 * u)) } }
      : {}),
    ...(sb.logoSrc
      ? {
          logo: {
            src: sb.logoSrc,
            position: "top_right" as const,
            width: Math.round(150 * u),
            opacity: 0.92,
          },
        }
      : {}),
    coverAtMs: hook ? Math.min(hook.endMs - 50, 1400) : 1200,
    output: { crf: sb.output?.crf ?? 20, preset: sb.output?.preset ?? "veryfast", audioBitrate: "160k" },
  };
}

function measureLongestLine(t: TextOverlay): number {
  return Math.max(
    0,
    ...t.text.split("\n").map((l) => measureText(t.uppercase ? l.toUpperCase() : l, t.fontSize, t.bold)),
  );
}

/** CTA button colour: the brand primary when it stands out from the backdrop, otherwise the best contrast. */
function ctaButtonColor(bg: Background, brand: BrandStyle): string {
  const mid =
    bg.type === "gradient"
      ? mixHex(bg.colors[0], bg.colors[1], 0.5)
      : bg.type === "color"
        ? bg.color
        : "#202020";
  if (contrastRatio(brand.primary, mid) >= 3) return brand.primary;
  const candidates = ["#FFFFFF", brand.background, brand.accent, brand.text];
  return candidates.reduce((best, c) => (contrastRatio(c, mid) > contrastRatio(best, mid) ? c : best));
}
