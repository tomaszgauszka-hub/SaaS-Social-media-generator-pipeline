import type { Transition } from "../contracts/ids.ts";
import type { PlanShot } from "../contracts/plan.ts";

/**
 * Timeline math of the master pass. Cuts stay exactly where the plan puts them: a transition into shot k starts
 * AT shot k's start, and the outgoing shot k−1 holds its last frame (tpad clone) for the transition length, so
 *
 *   xfade offset_k = startMs_k        and        total = Σ durationMs = plan.durationMs
 *
 * — voice segments, SFX cues, captions and the CTA window (all planned on absolute time) never drift.
 */

/** Transition id (whitelist) → FFmpeg xfade mode; `null` = hard cut. Fixed table, never model text. */
export const XFADE_MODE: Record<Transition, string | null> = {
  cut: null,
  fade: "fade",
  fadeblack: "fadeblack",
  fadewhite: "fadewhite",
  slideleft: "slideleft",
  slideup: "slideup",
  smoothleft: "smoothleft",
  wipeleft: "wipeleft",
  circleopen: "circleopen",
  zoomin: "zoomin",
  dissolve: "dissolve",
};

export interface ShotWindow {
  shotId: string;
  startMs: number;
  durationMs: number;
  /** transition INTO this shot (null mode = cut) */
  mode: string | null;
  transitionMs: number;
  /** freeze-frame tail this shot needs for the next shot's transition */
  holdMs: number;
}

/** A transition may take at most 40 % of the incoming shot and never more than 800 ms. */
export function clampTransition(incomingMs: number, requestedMs: number): number {
  return Math.max(0, Math.min(800, requestedMs, Math.floor(incomingMs * 0.4)));
}

export function shotWindows(
  shots: readonly Pick<PlanShot, "id" | "startMs" | "durationMs" | "transitionIn">[],
): ShotWindow[] {
  const windows = shots.map((s, i): ShotWindow => {
    const mode = i === 0 ? null : XFADE_MODE[s.transitionIn.type];
    const ms = mode ? clampTransition(s.durationMs, s.transitionIn.ms) : 0;
    return {
      shotId: s.id,
      startMs: s.startMs,
      durationMs: s.durationMs,
      mode: ms > 0 ? mode : null,
      transitionMs: ms,
      holdMs: 0,
    };
  });
  for (let i = 0; i < windows.length - 1; i++) windows[i]!.holdMs = windows[i + 1]!.transitionMs;
  return windows;
}

/** Plans are contiguous (shot k starts where k−1 ends); the composer refuses anything else. */
export function assertContiguous(windows: readonly ShotWindow[], durationMs: number): void {
  let t = 0;
  for (const w of windows) {
    if (w.startMs !== t) throw new Error(`shot ${w.shotId} starts at ${w.startMs} ms, expected ${t} ms`);
    t += w.durationMs;
  }
  if (t !== durationMs) throw new Error(`shots last ${t} ms but the plan is ${durationMs} ms`);
}

export const sec = (ms: number): string => (Math.round(ms) / 1000).toFixed(3);
