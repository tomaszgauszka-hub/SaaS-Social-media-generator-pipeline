import type { RenderPlan, ResolvedBeat, TransitionType } from "@cre/creative";
import type React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { Background, BeatBackground } from "./Background.tsx";
import { DemoLabel, Disclosure, Grain, ProgressBar, Vignette } from "./Global.tsx";
import { MediaView } from "./MediaView.tsx";
import { OverlayView, sliderPct } from "./overlays/index.tsx";
import { TextView } from "./TextView.tsx";
import { clamp01, ease } from "./util.ts";

/**
 * The reel: a persistent kit background, beats in overlapping sequences (the incoming beat's transition overlaps
 * the end of the outgoing one, so total duration never changes), then global layers.
 */
export const Reel: React.FC<{ plan: RenderPlan }> = ({ plan }) => {
  const { fps } = useVideoConfig();
  const toF = (ms: number) => Math.round((ms * fps) / 1000);
  return (
    <AbsoluteFill style={{ backgroundColor: plan.style.palette.bg, overflow: "hidden" }}>
      <Background plan={plan} />
      {plan.beats.map((beat, i) => {
        const inMs = beat.transitionIn.durationMs;
        const from = Math.max(0, toF(beat.startMs - inMs));
        const end = toF(beat.startMs + beat.durationMs);
        const next = plan.beats[i + 1];
        return (
          <Sequence key={beat.id} from={from} durationInFrames={Math.max(1, end - from)} layout="none">
            <BeatShell
              plan={plan}
              beat={beat}
              next={next}
              offsetMs={beat.startMs - Math.max(0, beat.startMs - inMs)}
            />
          </Sequence>
        );
      })}
      {plan.global.progressBar ? <ProgressBar plan={plan} /> : null}
      {plan.global.disclosure ? <Disclosure plan={plan} /> : null}
      <Vignette plan={plan} />
      <Grain plan={plan} />
      {plan.global.demoLabel ? <DemoLabel plan={plan} /> : null}
    </AbsoluteFill>
  );
};

interface TransitionLook {
  transform: string;
  opacity: number;
  filter: string;
  clipPath?: string;
  flash?: number;
}

function enterLook(type: TransitionType, p: number, W: number, H: number): TransitionLook {
  const base: TransitionLook = { transform: "", opacity: 1, filter: "" };
  if (p >= 1) return base;
  switch (type) {
    case "cut":
    case "match_cut":
      return base;
    case "whip_left":
    case "whip_right":
    case "whip_up": {
      const e = ease.inOutCubic(p);
      const blur = Math.sin(Math.PI * p) * 26;
      const off = (1 - e) * (type === "whip_up" ? H : W);
      const t =
        type === "whip_left"
          ? `translateX(${off}px)`
          : type === "whip_right"
            ? `translateX(${-off}px)`
            : `translateY(${off}px)`;
      return { transform: t, opacity: 1, filter: blur > 0.5 ? `blur(${blur.toFixed(1)}px)` : "" };
    }
    case "slide_left": {
      const e = ease.outCubic(p);
      return { transform: `translateX(${(1 - e) * W * 0.32}px)`, opacity: clamp01(p * 1.6), filter: "" };
    }
    case "slide_up": {
      const e = ease.outCubic(p);
      return { transform: `translateY(${(1 - e) * H * 0.18}px)`, opacity: clamp01(p * 1.6), filter: "" };
    }
    case "scale_in": {
      const e = ease.outCubic(p);
      return { transform: `scale(${1.14 - 0.14 * e})`, opacity: clamp01(p * 1.4), filter: "" };
    }
    case "blur": {
      const e = ease.inOutSine(p);
      return {
        transform: `scale(${1.03 - 0.03 * e})`,
        opacity: e,
        filter: `blur(${((1 - e) * 28).toFixed(1)}px)`,
      };
    }
    case "fade":
      return { transform: "", opacity: ease.inOutSine(p), filter: "" };
    case "mask_wipe": {
      const e = ease.inOutCubic(p);
      const x = (1 - e) * 130 - 15;
      return {
        transform: "",
        opacity: 1,
        filter: "",
        clipPath: `polygon(${x}% 0, 115% 0, 115% 100%, ${x - 15}% 100%)`,
      };
    }
    case "flash":
      return { transform: "", opacity: p < 0.5 ? 0 : 1, filter: "", flash: 1 - Math.abs(p - 0.5) * 2 };
  }
}

function exitLook(type: TransitionType, q: number, W: number, H: number): TransitionLook {
  const base: TransitionLook = { transform: "", opacity: 1, filter: "" };
  if (q <= 0) return base;
  switch (type) {
    case "whip_left":
    case "whip_right":
    case "whip_up": {
      const e = ease.inOutCubic(q);
      const blur = Math.sin(Math.PI * q) * 26;
      const off = e * (type === "whip_up" ? H : W);
      const t =
        type === "whip_left"
          ? `translateX(${-off}px)`
          : type === "whip_right"
            ? `translateX(${off}px)`
            : `translateY(${-off}px)`;
      return { transform: t, opacity: 1, filter: blur > 0.5 ? `blur(${blur.toFixed(1)}px)` : "" };
    }
    case "slide_left":
      return { transform: `translateX(${-ease.inCubic(q) * W * 0.12}px)`, opacity: 1 - q * 0.6, filter: "" };
    case "slide_up":
      return { transform: `translateY(${-ease.inCubic(q) * H * 0.06}px)`, opacity: 1 - q * 0.6, filter: "" };
    case "scale_in":
      return { transform: `scale(${1 - 0.06 * ease.inCubic(q)})`, opacity: 1 - q * 0.7, filter: "" };
    case "blur":
      return { transform: "", opacity: 1 - ease.inOutSine(q), filter: `blur(${(q * 24).toFixed(1)}px)` };
    case "fade":
      return { transform: "", opacity: 1 - ease.inOutSine(q), filter: "" };
    case "flash":
      return { transform: "", opacity: q < 0.5 ? 1 : 0, filter: "" };
    case "cut":
    case "match_cut":
    case "mask_wipe":
      return base;
  }
}

const BeatShell: React.FC<{
  plan: RenderPlan;
  beat: ResolvedBeat;
  next: ResolvedBeat | undefined;
  offsetMs: number;
}> = ({ plan, beat, next, offsetMs }) => {
  const frame = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const ms = (frame * 1000) / fps - offsetMs;
  const inMs = beat.transitionIn.durationMs;
  const p = inMs > 0 ? clamp01((ms + inMs) / inMs) : 1;
  const nextMs = next?.transitionIn.durationMs ?? 0;
  const q = next && nextMs > 0 ? clamp01((ms - (beat.durationMs - nextMs)) / nextMs) : 0;
  const a = enterLook(beat.transitionIn.type, p, W, H);
  const b = next ? exitLook(next.transitionIn.type, q, W, H) : { transform: "", opacity: 1, filter: "" };
  const style: React.CSSProperties = {
    transform: [a.transform, b.transform].filter(Boolean).join(" ") || undefined,
    opacity: a.opacity * b.opacity,
    filter: [a.filter, b.filter].filter(Boolean).join(" ") || undefined,
    clipPath: a.clipPath,
    transformOrigin: "50% 50%",
  };
  return (
    <AbsoluteFill style={style}>
      <BeatView plan={plan} beat={beat} ms={ms} />
      {a.flash ? <AbsoluteFill style={{ backgroundColor: "#FFFFFF", opacity: a.flash }} /> : null}
    </AbsoluteFill>
  );
};

const ORDER: Record<string, number> = {
  background: 0,
  before: 1,
  after: 2,
  left: 1,
  right: 1,
  primary: 3,
  secondary: 4,
  inset: 5,
};

/** overlays that belong to the scene and move with the camera; everything else is UI and stays put */
const WORLD_OVERLAYS = new Set([
  "highlight",
  "callout",
  "measure",
  "arrow",
  "particles",
  "light_sweep",
  "cursor",
]);

export const BeatView: React.FC<{ plan: RenderPlan; beat: ResolvedBeat; ms: number }> = ({
  plan,
  beat,
  ms,
}) => {
  const slider = beat.overlays.find((o) => o.kind === "slider");
  const pct = slider && slider.kind === "slider" ? sliderPct(slider, ms) : null;
  const media = [...beat.media].sort((x, y) => (ORDER[x.slot] ?? 3) - (ORDER[y.slot] ?? 3));
  const panels = beat.overlays.filter((o) => o.kind === "panel");
  const world = beat.overlays.filter((o) => WORLD_OVERLAYS.has(o.kind));
  const ui = beat.overlays.filter(
    (o) => o.kind !== "panel" && o.kind !== "slider" && !WORLD_OVERLAYS.has(o.kind),
  );
  // camera: linear drift over the whole beat (eased moves stall at the ends and read as stills)
  const t = clamp01(ms / Math.max(1, beat.durationMs));
  const cam = beat.camera;
  const z = cam.zoom[0] + (cam.zoom[1] - cam.zoom[0]) * t;
  const cx = cam.x[0] + (cam.x[1] - cam.x[0]) * t;
  const cy = cam.y[0] + (cam.y[1] - cam.y[0]) * t;
  const moving = z !== 1 || cx !== 0 || cy !== 0;
  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={
          moving
            ? {
                transform: `translate(${cx.toFixed(2)}px, ${cy.toFixed(2)}px) scale(${z.toFixed(5)})`,
                transformOrigin: "50% 50%",
              }
            : undefined
        }
      >
        <BeatBackground plan={plan} beat={beat} ms={ms} />
        {media.map((m, i) => (
          <MediaView
            key={`${m.assetId}-${i}`}
            plan={plan}
            media={m}
            ms={ms}
            beatMs={beat.durationMs}
            {...(m.slot === "after" && pct !== null ? { revealPct: pct } : {})}
          />
        ))}
        {world.map((o) => (
          <OverlayView key={o.id} plan={plan} beat={beat} overlay={o} ms={ms} />
        ))}
      </AbsoluteFill>
      {slider && slider.kind === "slider" ? (
        <OverlayView plan={plan} beat={beat} overlay={slider} ms={ms} />
      ) : null}
      {panels.map((o) => (
        <OverlayView key={o.id} plan={plan} beat={beat} overlay={o} ms={ms} />
      ))}
      {beat.texts.map((t) => (
        <TextView key={t.id} plan={plan} text={t} ms={ms} beatMs={beat.durationMs} />
      ))}
      {ui.map((o) => (
        <OverlayView key={o.id} plan={plan} beat={beat} overlay={o} ms={ms} />
      ))}
    </AbsoluteFill>
  );
};
