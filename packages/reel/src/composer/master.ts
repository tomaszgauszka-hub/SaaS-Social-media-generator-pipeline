import type { ShotClip, TextElement } from "../contracts/media.ts";
import type { ReelPlan } from "../contracts/plan.ts";
import type { PlatformProfile, Rect } from "../contracts/profiles.ts";
import { assertContiguous, shotWindows } from "./timeline.ts";

/**
 * Master pass (language-, platform- and brand-free): shot clips → one 1080×1920 @ plan.fps video with the planned
 * transitions. No text, no logo, no audio — every locale, every platform, every A/B copy and even other brand
 * channels selling the same product reuse this file. The logo is placed per platform in the localized pass.
 */

export interface LogoInput {
  path: string;
  /** source PNG size */
  width: number;
  height: number;
  /** on-frame width */
  widthPx: number;
  position: ReelPlan["branding"]["logo"]["position"];
}

const MARGIN = 48;
/** logo bottom ↔ the text band's panels (the CTA panel overshoots its box by ~4 px while it pops in) */
const LOGO_GAP = 8;
const MIN_LOGO_H = 24;

/** Top of the highest text panel in the upper half of the frame (the hook / overlay / CTA band), if any. */
export function textBandTop(
  texts: readonly Pick<TextElement, "box" | "panel">[],
  H: number,
): number | undefined {
  const tops = texts.map((t) => t.box.y - (t.panel?.padding ?? 0)).filter((y) => y < H / 2);
  return tops.length ? Math.min(...tops) : undefined;
}

/**
 * Where the logo goes for a platform: outside every platform UI zone. A top logo also stays above the text band
 * (`textTop`, see textBandTop): when it is too tall for the room it is scaled down (aspect kept, even size).
 */
export function logoRect(
  position: LogoInput["position"],
  platform: PlatformProfile,
  w: number,
  h: number,
  textTop?: number,
): Rect {
  const W = platform.width;
  const top = Math.max(0, ...platform.unsafe.filter((u) => u.rect.y === 0).map((u) => u.rect.h));
  const bottom = Math.min(
    platform.height,
    ...platform.unsafe
      .filter((u) => u.rect.y > platform.height / 2 && u.rect.w >= W * 0.9)
      .map((u) => u.rect.y),
  );
  const rail = Math.min(W, ...platform.unsafe.filter((u) => u.rect.x > W / 2).map((u) => u.rect.x));
  const y = top + 14;
  const room = textTop === undefined ? h : Math.max(MIN_LOGO_H, textTop - LOGO_GAP - y);
  const s = Math.min(1, room / h);
  const tw = s < 1 ? Math.max(2, Math.floor((w * s) / 2) * 2) : w;
  const th = s < 1 ? Math.max(2, Math.floor((h * s) / 2) * 2) : h;
  switch (position) {
    case "top_left":
      return { x: MARGIN, y, w: tw, h: th };
    case "top_right":
      return { x: W - MARGIN - tw, y, w: tw, h: th };
    // bottom logos keep their size: the text band is at the top
    case "bottom_right":
      return { x: Math.min(W - MARGIN, rail - 24) - w, y: bottom - h - 24, w, h };
    case "end_card":
      return { x: Math.round((W - w) / 2), y: bottom - h - 140, w, h };
  }
}

const frames = (ms: number, fps: number) => Math.round((ms * fps) / 1000);
const fsec = (f: number, fps: number) => (f / fps).toFixed(4);

export interface MasterArgs {
  args: string[];
  frameCount: number;
}

/**
 * Pure: logo overlay for one platform pass — an extra looped-image input plus filter steps that put the PNG
 * (alpha, scaled to `widthPx`, smaller when a top logo would reach the text band) outside the platform's UI
 * zones with a short alpha fade over the logo window.
 */
export function logoOverlay(o: {
  logo: LogoInput;
  window: { startMs: number; endMs: number };
  platform: PlatformProfile;
  fps: number;
  durationMs: number;
  inputIndex: number;
  inLabel: string;
  outLabel: string;
  /** top of the text band's panels (textBandTop): a top logo stays above it */
  textTop?: number;
}): { inputArgs: string[]; graph: string[]; box: Rect } {
  const lw = Math.round(o.logo.widthPx / 2) * 2;
  const lh = Math.round(((o.logo.height / o.logo.width) * lw) / 2) * 2;
  const box = logoRect(o.logo.position, o.platform, lw, lh, o.textTop);
  const s = Math.max(0, o.window.startMs) / 1000;
  const e = Math.min(o.durationMs, o.window.endMs) / 1000;
  const fade = Math.min(0.3, (e - s) / 4);
  return {
    inputArgs: [
      "-loop",
      "1",
      "-framerate",
      String(o.fps),
      "-t",
      ((o.durationMs + 1000) / 1000).toFixed(3),
      "-i",
      o.logo.path,
    ],
    graph: [
      `[${o.inputIndex}:v]format=rgba,scale=${box.w}:${box.h}:flags=lanczos,` +
        `fade=t=in:st=${s.toFixed(3)}:d=${fade.toFixed(3)}:alpha=1,fade=t=out:st=${(e - fade).toFixed(3)}:d=${fade.toFixed(3)}:alpha=1[logo]`,
      `[${o.inLabel}][logo]overlay=x=${Math.round(box.x)}:y=${Math.round(box.y)}:enable='between(t,${s.toFixed(3)},${e.toFixed(3)})':eof_action=pass[${o.outLabel}]`,
    ],
    box,
  };
}

/**
 * Pure: the FFmpeg arguments of the master pass. Times are quantised to frames so the output has exactly
 * round(durationMs · fps / 1000) frames and every cut lands on the planned frame.
 */
export function buildMasterArgs(opts: {
  plan: Pick<ReelPlan, "shots" | "durationMs" | "fps" | "resolution">;
  clips: readonly Pick<ShotClip, "shotId" | "path">[];
  outPath: string;
  crf?: number;
}): MasterArgs {
  const { plan, clips } = opts;
  const { width: W, height: H } = plan.resolution;
  const fps = plan.fps;
  const windows = shotWindows(plan.shots);
  assertContiguous(windows, plan.durationMs);
  const total = frames(plan.durationMs, fps);
  // transition length in frames (< 2 frames is a cut); the outgoing shot holds exactly that many frames
  const tf = windows.map((w) =>
    w.mode && frames(w.transitionMs, fps) >= 2 ? frames(w.transitionMs, fps) : 0,
  );

  const args: string[] = [];
  const graph: string[] = [];
  windows.forEach((w, i) => {
    const clip = clips.find((c) => c.shotId === w.shotId);
    if (!clip) throw new Error(`no clip for shot ${w.shotId}`);
    args.push("-i", clip.path);
    const f0 = frames(w.startMs, fps);
    const f1 = i === windows.length - 1 ? total : frames(windows[i + 1]!.startMs, fps);
    const hold = tf[i + 1] ?? 0;
    const len = f1 - f0 + hold;
    graph.push(
      `[${i}:v]fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1,format=yuv420p,` +
        `tpad=stop_mode=clone:stop_duration=${fsec(len + 1, fps)},trim=end_frame=${len},setpts=PTS-STARTPTS[s${i}]`,
    );
  });
  let acc = "s0";
  windows.slice(1).forEach((w, k) => {
    const i = k + 1;
    const out = `x${i}`;
    const d = tf[i]!;
    if (!w.mode || d === 0) graph.push(`[${acc}][s${i}]concat=n=2:v=1:a=0[${out}]`);
    else {
      graph.push(
        `[${acc}][s${i}]xfade=transition=${w.mode}:duration=${fsec(d, fps)}:offset=${fsec(frames(w.startMs, fps), fps)}[${out}]`,
      );
    }
    acc = out;
  });

  graph.push(`[${acc}]format=yuv420p,setsar=1[vout]`);

  args.push(
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[vout]",
    "-an",
    "-frames:v",
    String(total),
    "-r",
    String(fps),
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    String(opts.crf ?? 14),
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(fps * 2),
    "-movflags",
    "+faststart",
    opts.outPath,
  );
  return { args, frameCount: total };
}
