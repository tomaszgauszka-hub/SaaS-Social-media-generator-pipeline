import type { Scene, TransitionType } from "./schema.ts";

/**
 * Timeline math for a sequence of scenes joined by transitions.
 *
 * Scenes overlap during a transition (xfade). With clip lengths d_k and transition lengths x_k (k ≥ 1):
 *   L_0 = d_0,  L_k = L_{k-1} + d_k − x_k,  scene k starts at S_k = L_{k-1} − x_k.
 * A "cut" has x_k = 0.
 */
export interface SceneWindow {
  index: number;
  id: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  transition: TransitionType;
  transitionMs: number;
}

export interface Timeline {
  windows: SceneWindow[];
  totalMs: number;
}

/** Transitions may not take more than 40 % of either neighbouring scene. */
export function clampTransitionMs(prevMs: number, curMs: number, requestedMs: number): number {
  return Math.max(0, Math.min(requestedMs, Math.floor(prevMs * 0.4), Math.floor(curMs * 0.4)));
}

export function computeTimeline(scenes: Pick<Scene, "id" | "durationMs" | "transitionIn">[]): Timeline {
  const windows: SceneWindow[] = [];
  let accumulated = 0;
  scenes.forEach((scene, index) => {
    if (index === 0) {
      windows.push({
        index,
        id: scene.id,
        startMs: 0,
        endMs: scene.durationMs,
        durationMs: scene.durationMs,
        transition: "cut",
        transitionMs: 0,
      });
      accumulated = scene.durationMs;
      return;
    }
    const prev = scenes[index - 1]!;
    const type = scene.transitionIn.type;
    const x =
      type === "cut"
        ? 0
        : clampTransitionMs(prev.durationMs, scene.durationMs, scene.transitionIn.durationMs);
    const start = accumulated - x;
    windows.push({
      index,
      id: scene.id,
      startMs: start,
      endMs: start + scene.durationMs,
      durationMs: scene.durationMs,
      transition: x === 0 ? "cut" : type,
      transitionMs: x,
    });
    accumulated = accumulated + scene.durationMs - x;
  });
  return { windows, totalMs: accumulated };
}

/**
 * Window in which a scene's text should be visible: after the incoming transition has half-completed and
 * before the outgoing one starts.
 */
export function textWindow(timeline: Timeline, index: number): { startMs: number; endMs: number } {
  const w = timeline.windows[index];
  if (!w) throw new RangeError(`scene index ${index} out of range`);
  const next = timeline.windows[index + 1];
  const start = w.startMs + Math.round(w.transitionMs * 0.5);
  const end = next ? next.startMs + Math.round(next.transitionMs * 0.5) : w.endMs;
  return { startMs: start, endMs: Math.max(start + 200, end) };
}
