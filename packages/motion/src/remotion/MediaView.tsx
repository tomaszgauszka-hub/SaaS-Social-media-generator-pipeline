import {
  containRect,
  coverRect,
  type BeatMedia,
  type MediaRef,
  type Rect,
  type RenderPlan,
} from "@cre/creative";
import type React from "react";
import { Img, OffthreadVideo, staticFile } from "remotion";
import { VECTORS } from "./demo-media/registry.tsx";
import { clamp01, ease, lerp, prog, resolveParams, rgba, spring } from "./util.ts";

/**
 * One media layer: contain / cover / macro framing, zoom over the beat, a motion preset, contact shadow and
 * backlight. Vector (demo) media are re-drawn at the target size every frame, so macro shots stay sharp.
 */
const MACRO_AT = { x: 540, y: 800 };

export function frameRect(ref: MediaRef, m: BeatMedia, t: number, W: number): Rect {
  const z = lerp(m.zoom[0], m.zoom[1], ease.inOutSine(t));
  if (m.crop === "macro") {
    const a = (m.focus ? ref.anchors[m.focus] : undefined) ?? { x: 0.5, y: 0.5 };
    const s = (W / ref.width) * z;
    return {
      x: MACRO_AT.x - a.x * ref.width * s,
      y: MACRO_AT.y - a.y * ref.height * s,
      w: ref.width * s,
      h: ref.height * s,
    };
  }
  const focus = m.focus ? ref.anchors[m.focus] : undefined;
  const r = m.crop === "cover" ? coverRect(ref, m.box, focus) : containRect(ref, m.box);
  const cx = m.box.x + m.box.w / 2;
  const cy = m.box.y + m.box.h / 2;
  return { x: cx + (r.x - cx) * z, y: cy + (r.y - cy) * z, w: r.w * z, h: r.h * z };
}

interface MotionLook {
  dx: number;
  dy: number;
  rotate: number;
  opacity: number;
  blur: number;
  clipPath?: string;
  perspective?: string;
}

function motionLook(m: BeatMedia, ms: number, beatMs: number, energy: number): MotionLook {
  const local = ms - m.enterMs;
  const t = clamp01(ms / Math.max(1, beatMs));
  // media that starts with the beat is visible during the incoming transition too
  const look: MotionLook = { dx: 0, dy: 0, rotate: 0, opacity: m.enterMs > 0 && local < 0 ? 0 : 1, blur: 0 };
  switch (m.motion) {
    case "whip_in": {
      const p = prog(local, 0, 360, ease.outQuint);
      look.dx = (1 - p) * 1000;
      look.rotate = (1 - p) * -9;
      look.blur = (1 - p) * 28;
      look.dy = Math.sin(((local > 360 ? local - 360 : 0) / 2600) * Math.PI * 2) * 6;
      break;
    }
    case "drop_in": {
      const s = spring(local, 0, { stiffness: 140, damping: 14 });
      look.dy = -(1 - s) * 300;
      look.opacity = prog(local, 0, 220);
      break;
    }
    case "tilt_in": {
      const p = prog(local, 0, 700, ease.outCubic);
      look.dx = (1 - p) * 260;
      look.perspective = `perspective(1800px) rotateY(${((1 - p) * -32).toFixed(2)}deg) rotateZ(${((1 - p) * 5).toFixed(2)}deg)`;
      look.opacity = prog(local, 0, 260);
      break;
    }
    case "slide_in_left":
    case "slide_in_right": {
      const p = prog(local, 0, 480, ease.outCubic);
      look.dx = (1 - p) * (m.motion === "slide_in_left" ? -760 : 760);
      look.opacity = prog(local, 0, 200);
      break;
    }
    case "product_float":
      look.dy = Math.sin((ms / 2600) * Math.PI * 2) * 9;
      look.rotate = Math.sin((ms / 3400) * Math.PI * 2) * 0.7;
      break;
    case "cinematic_push":
      look.dy = -14 * ease.inOutSine(t);
      break;
    case "pan_left":
    case "pan_right":
      look.dx = (m.motion === "pan_left" ? -1 : 1) * (36 + energy * 24) * ease.inOutSine(t);
      break;
    case "pan_up":
    case "pan_down":
      look.dy = (m.motion === "pan_up" ? -1 : 1) * (40 + energy * 30) * ease.inOutSine(t);
      break;
    case "crop_reveal": {
      const p = prog(local, 0, 520, ease.outCubic);
      look.clipPath = `inset(0 ${((1 - p) * 50).toFixed(2)}% 0 ${((1 - p) * 50).toFixed(2)}%)`;
      break;
    }
    case "masked_reveal": {
      const p = prog(local, 0, 650, ease.outCubic);
      look.clipPath = `circle(${(p * 80).toFixed(2)}% at 50% 50%)`;
      break;
    }
    case "parallax":
      look.dx = -30 * ease.inOutSine(t);
      look.dy = -10 * ease.inOutSine(t);
      break;
    case "macro_drift":
      look.dx = Math.sin(t * Math.PI) * 14;
      look.dy = -10 * t;
      break;
    case "slow_zoom":
    case "none":
      break;
  }
  return look;
}

export const MediaView: React.FC<{
  plan: RenderPlan;
  media: BeatMedia;
  ms: number;
  beatMs: number;
  /** before/after: show only the left `revealPct` of this layer */
  revealPct?: number;
}> = ({ plan, media: m, ms, beatMs, revealPct }) => {
  const ref = plan.media[m.assetId];
  if (!ref) return null;
  const W = plan.format.width;
  const t = clamp01(ms / Math.max(1, beatMs));
  const r = frameRect(ref, m, t, W);
  const look = motionLook(m, ms, beatMs, plan.style.motion.energy);
  const params = resolveParams(ref.params, m.params, m.animate, ms);
  const clipToBox = m.crop === "cover" || m.slot === "left" || m.slot === "right";
  const palette = plan.style.palette;
  const base = ref.anchors.base;
  const shadowY = base ? r.y + base.y * r.h : r.y + r.h * 0.96;

  const content = (() => {
    if (ref.kind === "vector") {
      const V = VECTORS[ref.src];
      if (!V) return <div style={{ position: "absolute", inset: 0, background: "#f0f", opacity: 0.4 }} />;
      return (
        <svg
          width={r.w}
          height={r.h}
          viewBox={`0 0 ${ref.width} ${ref.height}`}
          style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}
        >
          <V.Component params={params} ms={ms} beatMs={beatMs} palette={palette} />
        </svg>
      );
    }
    const src = ref.url ? (ref.url.startsWith("http") ? ref.url : staticFile(ref.url)) : "";
    if (ref.kind === "video")
      return (
        <OffthreadVideo
          src={src}
          muted
          style={{ position: "absolute", left: 0, top: 0, width: r.w, height: r.h, objectFit: "fill" }}
        />
      );
    return (
      <Img
        src={src}
        style={{ position: "absolute", left: 0, top: 0, width: r.w, height: r.h, objectFit: "fill" }}
      />
    );
  })();

  const transform = [
    look.perspective,
    `translate(${look.dx.toFixed(2)}px, ${look.dy.toFixed(2)}px)`,
    look.rotate ? `rotate(${look.rotate.toFixed(3)}deg)` : "",
    m.rotate ? `rotate(${m.rotate}deg)` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const layer = (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        opacity: look.opacity * m.opacity,
      }}
    >
      {m.backlight ? (
        <div
          style={{
            position: "absolute",
            left: r.x + r.w * 0.5 - r.w * 0.62,
            top: r.y + r.h * 0.48 - r.w * 0.62,
            width: r.w * 1.24,
            height: r.w * 1.24,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${rgba(palette.glow, 0.34)} 0%, ${rgba(palette.glow, 0.1)} 42%, ${rgba(palette.glow, 0)} 70%)`,
            transform: `translate(${look.dx * 0.4}px, ${look.dy * 0.4}px)`,
          }}
        />
      ) : null}
      {m.shadow ? (
        <div
          style={{
            position: "absolute",
            left: r.x + r.w * 0.16 + look.dx,
            top: shadowY - r.h * 0.035,
            width: r.w * 0.68,
            height: r.h * 0.07,
            borderRadius: "50%",
            background:
              "radial-gradient(ellipse, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.22) 45%, rgba(0,0,0,0) 72%)",
            filter: "blur(10px)",
            opacity: clamp01(1 - Math.abs(look.dy) / 260),
          }}
        />
      ) : null}
      <div
        style={{
          position: "absolute",
          left: r.x,
          top: r.y,
          width: r.w,
          height: r.h,
          transform,
          transformOrigin: "50% 60%",
          filter: look.blur > 0.4 ? `blur(${look.blur.toFixed(1)}px)` : undefined,
          clipPath: look.clipPath,
        }}
      >
        {content}
      </div>
    </div>
  );

  const clip: React.CSSProperties = {};
  if (clipToBox)
    clip.clipPath = `inset(${m.box.y}px ${W - m.box.x - m.box.w}px ${plan.format.height - m.box.y - m.box.h}px ${m.box.x}px)`;
  if (revealPct !== undefined) clip.clipPath = `inset(0 ${((1 - revealPct) * 100).toFixed(3)}% 0 0)`;
  return (
    <div style={{ position: "absolute", inset: 0, ...clip }} data-media={m.assetId}>
      {layer}
    </div>
  );
};
