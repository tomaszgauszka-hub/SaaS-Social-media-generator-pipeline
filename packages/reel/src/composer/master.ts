import type { ShotClip } from "../contracts/media.ts";
import type { ReelPlan } from "../contracts/plan.ts";
import type { PlatformProfile, Rect } from "../contracts/profiles.ts";
import { assertContiguous, shotWindows } from "./timeline.ts";

/**
 * Master pass (language-free): shot clips → one 1080×1920 @ plan.fps video with the planned transitions and the
 * brand logo. No text, no audio — every locale and A/B copy of the same visual plan reuses this file.
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

/** Where the logo goes for a platform: outside every platform UI zone. */
export function logoRect(
  position: LogoInput["position"],
  platform: PlatformProfile,
  w: number,
  h: number,
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
  switch (position) {
    case "top_left":
      return { x: MARGIN, y: top + 14, w, h };
    case "top_right":
      return { x: W - MARGIN - w, y: top + 14, w, h };
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
  logoBox?: Rect;
}

/**
 * Pure: the FFmpeg arguments of the master pass. Times are quantised to frames so the output has exactly
 * round(durationMs · fps / 1000) frames and every cut lands on the planned frame.
 */
export function buildMasterArgs(opts: {
  plan: Pick<ReelPlan, "shots" | "durationMs" | "fps" | "resolution" | "branding">;
  clips: readonly Pick<ShotClip, "shotId" | "path">[];
  platform: PlatformProfile;
  logo?: LogoInput;
  outPath: string;
  crf?: number;
}): MasterArgs {
  const { plan, clips, platform } = opts;
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

  let logoBox: Rect | undefined;
  const logoWin = plan.branding.logo;
  if (opts.logo && logoWin.enabled && logoWin.endMs > logoWin.startMs) {
    const li = windows.length;
    const lw = Math.round(opts.logo.widthPx / 2) * 2;
    const lh = Math.round((opts.logo.height / opts.logo.width) * lw);
    logoBox = logoRect(logoWin.position, platform, lw, lh);
    const s = Math.max(0, logoWin.startMs) / 1000;
    const e = Math.min(plan.durationMs, logoWin.endMs) / 1000;
    const fade = Math.min(0.3, (e - s) / 4);
    args.push("-loop", "1", "-framerate", String(fps), "-t", fsec(total + 1, fps), "-i", opts.logo.path);
    graph.push(
      `[${li}:v]format=rgba,scale=${lw}:${lh}:flags=lanczos,` +
        `fade=t=in:st=${s.toFixed(3)}:d=${fade.toFixed(3)}:alpha=1,fade=t=out:st=${(e - fade).toFixed(3)}:d=${fade.toFixed(3)}:alpha=1[logo]`,
    );
    graph.push(
      `[${acc}][logo]overlay=x=${Math.round(logoBox.x)}:y=${Math.round(logoBox.y)}:enable='between(t,${s.toFixed(3)},${e.toFixed(3)})':eof_action=pass[lg]`,
    );
    acc = "lg";
  }
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
  return { args, frameCount: total, ...(logoBox ? { logoBox } : {}) };
}
