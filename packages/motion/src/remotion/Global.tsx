import type { RenderPlan } from "@cre/creative";
import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { TextView } from "./TextView.tsx";
import { clamp01, fontAlias, isDark, rgba } from "./util.ts";

/** Global layers: segmented progress, disclosure, vignette, film grain and the DEMO label. */
export const ProgressBar: React.FC<{ plan: RenderPlan }> = ({ plan }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ms = (frame * 1000) / fps;
  const p = plan.style.palette;
  const x0 = 72;
  const x1 = 1008;
  const gap = 8;
  const n = plan.beats.length;
  const segW = (x1 - x0 - gap * (n - 1)) / n;
  const track = isDark(p.bg) ? "rgba(255,255,255,0.18)" : rgba(p.ink, 0.14);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {plan.beats.map((b, i) => {
        const fill = clamp01((ms - b.startMs) / b.durationMs);
        return (
          <div
            key={b.id}
            style={{
              position: "absolute",
              left: x0 + i * (segW + gap),
              top: 156,
              width: segW,
              height: 6,
              borderRadius: 3,
              background: track,
              overflow: "hidden",
            }}
          >
            <div style={{ width: `${fill * 100}%`, height: "100%", background: p.accent, borderRadius: 3 }} />
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

export const Disclosure: React.FC<{ plan: RenderPlan }> = ({ plan }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const d = plan.global.disclosure;
  if (!d) return null;
  const ms = (frame * 1000) / fps;
  return <TextView plan={plan} text={{ ...d, color: "ink" }} ms={ms} beatMs={plan.durationMs} />;
};

export const Vignette: React.FC<{ plan: RenderPlan }> = ({ plan }) => {
  const v = plan.style.vignette;
  if (v <= 0) return null;
  const dark = isDark(plan.style.palette.bg);
  const edge = dark ? `rgba(0,0,0,${v})` : rgba(plan.style.palette.bg2, v * 1.6);
  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        background: `radial-gradient(120% 85% at 50% 45%, rgba(0,0,0,0) 55%, ${edge} 100%)`,
      }}
    />
  );
};

export const Grain: React.FC<{ plan: RenderPlan }> = ({ plan }) => {
  const frame = useCurrentFrame();
  const g = plan.style.grain;
  if (g <= 0) return null;
  const seed = Math.floor(frame / 2) % 97;
  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        opacity: g,
        mixBlendMode: isDark(plan.style.palette.bg) ? "screen" : "multiply",
      }}
    >
      <svg width="100%" height="100%">
        <filter id={`grain${seed}`}>
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves="2"
            seed={seed}
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#grain${seed})`} />
      </svg>
    </AbsoluteFill>
  );
};

/** Burned-in marker for placeholder / demo media — such content must never pass as production output. */
export const DemoLabel: React.FC<{ plan: RenderPlan }> = ({ plan }) => {
  const label = plan.global.demoLabel;
  if (!label) return null;
  const dark = isDark(plan.style.palette.bg);
  return (
    <div
      style={{
        position: "absolute",
        left: 72,
        top: 76,
        padding: "10px 18px",
        borderRadius: 8,
        background: dark ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.75)",
        border: `1.5px solid ${dark ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.25)"}`,
        color: dark ? "rgba(255,255,255,0.88)" : "rgba(0,0,0,0.72)",
        fontFamily: fontAlias("Inter"),
        fontWeight: 700,
        fontSize: 22,
        letterSpacing: "0.14em",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </div>
  );
};
