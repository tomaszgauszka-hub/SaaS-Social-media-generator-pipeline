import { drawnBounds, type RenderPlan, type ResolvedText, type TextSpan } from "@cre/creative";
import type React from "react";
import { clamp01, ease, fontAlias, isDark, prog, rgba, spring, textColor } from "./util.ts";

/**
 * Renders a measured text element: explicit lines (never wraps), semantic emphasis styled by the kit, entrance
 * animation, optional legibility surface. Display roles get the kit's skew.
 */
const SKEWED = new Set(["DISPLAY", "HEADLINE", "STAT", "CTA"]);

export const TextView: React.FC<{ plan: RenderPlan; text: ResolvedText; ms: number; beatMs: number }> = ({
  plan,
  text: t,
  ms,
  beatMs,
}) => {
  if (!t.lines.length) return null;
  const style = plan.style;
  const p = style.palette;
  const color = textColor(p, t.color);
  const local = ms - t.delayMs;
  const exitAt = beatMs - t.exitBeforeEndMs;
  const exit = t.exitBeforeEndMs > 0 ? 1 - prog(ms, exitAt, 200) : 1;
  if (local < -10) return null;
  const skew = SKEWED.has(t.role) ? style.displaySkew : 0;
  const lineH = t.lineHeightPx;
  const blockH = t.lines.length * lineH;
  const top =
    t.vAlign === "top"
      ? t.box.y
      : t.vAlign === "middle"
        ? t.box.y + (t.box.h - blockH) / 2
        : t.box.y + t.box.h - blockH;

  const surface = (() => {
    if (t.surface === "chip") {
      const b = drawnBounds(t);
      const lightInk = !isDark(color);
      return (
        <div
          style={{
            position: "absolute",
            left: b.x - 16,
            top: b.y - 8,
            width: b.w + 32,
            height: b.h + 16,
            borderRadius: 12,
            background: lightInk ? "rgba(8,9,12,0.5)" : "rgba(255,255,255,0.72)",
            opacity: clamp01(local / 200),
          }}
        />
      );
    }
    if (t.surface !== "scrim") return null;
    const lightInk = !isDark(color);
    const a = clamp01(local / 300);
    const pad = 110;
    return (
      <div
        style={{
          position: "absolute",
          left: t.box.x - pad,
          top: top - pad,
          width: t.box.w + pad * 2,
          height: blockH + pad * 2,
          background: lightInk
            ? `radial-gradient(ellipse at 50% 50%, rgba(0,0,0,${0.55 * a}) 0%, rgba(0,0,0,${0.36 * a}) 45%, rgba(0,0,0,0) 72%)`
            : `radial-gradient(ellipse at 50% 50%, rgba(255,255,255,${0.7 * a}) 0%, rgba(255,255,255,${0.45 * a}) 45%, rgba(255,255,255,0) 72%)`,
          filter: "blur(6px)",
        }}
      />
    );
  })();

  return (
    <div style={{ position: "absolute", inset: 0, opacity: exit, pointerEvents: "none" }}>
      {surface}
      {t.lines.map((line, i) => {
        const anim = lineAnim(t, i, local);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: t.box.x,
              top: top + i * lineH,
              width: t.box.w,
              height: lineH,
              overflow: t.animation === "mask_up" ? "hidden" : "visible",
              paddingBottom: t.animation === "mask_up" ? lineH * 0.18 : 0,
              marginBottom: t.animation === "mask_up" ? -lineH * 0.18 : 0,
            }}
          >
            <div
              style={{
                fontFamily: fontAlias(t.font.family),
                fontWeight: t.font.weight,
                fontStyle: t.font.style,
                fontSize: t.fontSize,
                lineHeight: `${lineH}px`,
                letterSpacing: `${t.font.letterSpacing}em`,
                color,
                whiteSpace: "pre",
                textAlign: t.align,
                fontVariantNumeric: t.role === "STAT" || t.role === "SPEC" ? "tabular-nums" : undefined,
                transform: `${anim.transform}${skew ? ` skewX(${skew}deg)` : ""}`,
                transformOrigin: t.align === "left" ? "0% 70%" : t.align === "right" ? "100% 70%" : "50% 70%",
                opacity: anim.opacity,
                filter: anim.blur > 0.3 ? `blur(${anim.blur.toFixed(1)}px)` : undefined,
                textShadow:
                  t.surface === "scrim" && !isDark(color) ? "0 2px 24px rgba(0,0,0,0.35)" : undefined,
              }}
            >
              {renderSpans(plan, t, line, local, i)}
            </div>
          </div>
        );
      })}
    </div>
  );
};

interface Anim {
  transform: string;
  opacity: number;
  blur: number;
}

function lineAnim(t: ResolvedText, i: number, local: number): Anim {
  const start = i * 75;
  switch (t.animation) {
    case "none":
      return { transform: "", opacity: local >= 0 ? 1 : 0, blur: 0 };
    case "mask_up": {
      const e = prog(local, start, 460, ease.outQuint);
      return { transform: `translateY(${((1 - e) * 112).toFixed(2)}%)`, opacity: 1, blur: 0 };
    }
    case "slide_left":
    case "slide_right": {
      const e = prog(local, start, 420, ease.outCubic);
      const d = t.animation === "slide_left" ? 90 : -90;
      return {
        transform: `translateX(${((1 - e) * d).toFixed(2)}px)`,
        opacity: clamp01((local - start) / 200),
        blur: 0,
      };
    }
    case "pop": {
      const s = spring(local, start, { stiffness: 220, damping: 15 });
      return {
        transform: `scale(${(0.55 + 0.45 * s).toFixed(4)})`,
        opacity: clamp01((local - start) / 140),
        blur: 0,
      };
    }
    case "scale_in": {
      const e = prog(local, start, 520, ease.outCubic);
      return { transform: `scale(${(1.18 - 0.18 * e).toFixed(4)})`, opacity: e, blur: (1 - e) * 8 };
    }
    case "word_stagger":
    case "typewriter":
      return { transform: "", opacity: 1, blur: 0 };
    case "rise":
    default: {
      const e = prog(local, start, 480, ease.outCubic);
      return { transform: `translateY(${((1 - e) * 46).toFixed(2)}px)`, opacity: e, blur: (1 - e) * 4 };
    }
  }
}

function renderSpans(
  plan: RenderPlan,
  t: ResolvedText,
  line: TextSpan[],
  local: number,
  lineIndex: number,
): React.ReactNode {
  const p = plan.style.palette;
  const style = plan.style.overlayStyle;
  let wordIndex = lineIndex * 4;
  return line.map((span, si) => {
    const words =
      t.animation === "word_stagger" || t.animation === "typewriter" ? span.text.split(/(\s+)/) : [span.text];
    const emphasis: React.CSSProperties = span.emphasis
      ? style === "industrial" || style === "racing"
        ? {
            backgroundColor: p.accent,
            color: p.accentInk,
            padding: "0 0.07em",
            margin: "0 -0.07em",
            boxDecorationBreak: "clone",
            WebkitBoxDecorationBreak: "clone",
          }
        : style === "tech"
          ? { color: p.accent, textShadow: `0 0 28px ${rgba(p.accent, 0.55)}` }
          : style === "rounded"
            ? {
                color: p.accent,
                backgroundImage: `linear-gradient(${rgba(p.accent, 0.22)}, ${rgba(p.accent, 0.22)})`,
                backgroundSize: "100% 0.28em",
                backgroundPosition: "0 88%",
                backgroundRepeat: "no-repeat",
              }
            : { color: p.accent }
      : {};
    return (
      <span key={si} style={emphasis}>
        {words.map((w, wi) => {
          if (!/\S/.test(w)) return w;
          const idx = wordIndex++;
          if (t.animation === "word_stagger") {
            const e = prog(local, idx * 70, 360, ease.outCubic);
            return (
              <span
                key={wi}
                style={{
                  display: "inline-block",
                  opacity: e,
                  transform: `translateY(${((1 - e) * 26).toFixed(2)}px)`,
                  filter: e < 1 ? `blur(${((1 - e) * 6).toFixed(1)}px)` : undefined,
                  whiteSpace: "pre",
                }}
              >
                {w}
              </span>
            );
          }
          if (t.animation === "typewriter") {
            const shown = Math.max(0, Math.floor((local - idx * 60) / 35));
            return <span key={wi}>{w.slice(0, shown)}</span>;
          }
          return <span key={wi}>{w}</span>;
        })}
      </span>
    );
  });
}
