import {
  COST_CATEGORIES,
  ComputeEntry,
  CostEntry,
  type ComputeEntryInput,
  type CostBreakdown,
  type CostCategory,
  type CostEntryInput,
} from "../contracts/cost.ts";
import type { Capability } from "../contracts/ids.ts";
import type { CostRecorder } from "../capabilities/types.ts";

const CATEGORY_OF: Partial<Record<Capability, CostCategory>> = {
  director: "llm",
  product_analysis: "llm",
  transcreation: "llm",
  image: "image",
  music: "music",
  voice: "tts",
  transcription: "transcription",
  sfx: "sfx",
  embedding: "embedding",
  generative_video: "generative_video",
  visual_qa: "visual_qa",
};

/**
 * Per-job cost tracker: every API call (or cache hit at cost 0) and every local compute step. Totals feed the
 * budget gate and the manifest. Thread-safe for the single-process async model (no awaits inside mutators).
 */
export class CostTracker implements CostRecorder {
  readonly entries: CostEntry[] = [];
  readonly computeEntries: ComputeEntry[] = [];
  private reservedMicros = 0;

  record(entry: CostEntryInput): void {
    const e = CostEntry.parse(entry);
    if (!e.category) e.category = CATEGORY_OF[e.capability];
    this.entries.push(e);
  }

  compute(entry: ComputeEntryInput): void {
    this.computeEntries.push(ComputeEntry.parse(entry));
  }

  /** API spend so far (micro-USD), optionally for one scope */
  spentMicros(scope?: string): number {
    return this.entries.filter((e) => !scope || e.scope === scope).reduce((s, e) => s + e.costMicros, 0);
  }

  /** reserve before a paid call so concurrent calls cannot jointly overspend; returns a release function */
  reserve(micros: number): () => void {
    this.reservedMicros += micros;
    let released = false;
    return () => {
      if (!released) this.reservedMicros -= micros;
      released = true;
    };
  }

  committedPlusReserved(): number {
    return this.spentMicros() + this.reservedMicros;
  }

  breakdown(scope?: string): CostBreakdown {
    const entries = this.entries.filter((e) => !scope || e.scope === scope || e.scope === "master");
    const compute = this.computeEntries.filter((e) => !scope || e.scope === scope || e.scope === "master");
    const byCategory = Object.fromEntries(COST_CATEGORIES.map((c) => [c, 0])) as Record<CostCategory, number>;
    for (const e of entries) byCategory[e.category ?? "llm"] += e.costMicros;
    const sumStage = (stage: ComputeEntry["stage"]) =>
      compute.filter((c) => c.stage === stage).reduce((s, c) => s + c.wallMs, 0);
    return {
      byCategory,
      totalApiMicros: entries.reduce((s, e) => s + e.costMicros, 0),
      tokens: {
        input: entries.reduce((s, e) => s + e.inputTokens, 0),
        output: entries.reduce((s, e) => s + e.outputTokens, 0),
      },
      compute: {
        blenderMs: sumStage("blender"),
        ffmpegMs: sumStage("ffmpeg"),
        audioMs: sumStage("audio_synth") + sumStage("tts_local"),
        otherMs: sumStage("qa") + sumStage("other"),
      },
      entries,
      computeEntries: compute,
    };
  }
}

/** Refuses a call whose estimate would push the job over its API budget. */
export class BudgetGate {
  constructor(
    readonly maxMicros: number,
    private readonly tracker: CostTracker,
  ) {}

  canSpend(estimateMicros: number): boolean {
    if (estimateMicros <= 0) return true;
    return this.tracker.committedPlusReserved() + estimateMicros <= this.maxMicros;
  }

  remainingMicros(): number {
    return Math.max(0, this.maxMicros - this.tracker.committedPlusReserved());
  }

  reserve(estimateMicros: number): () => void {
    return this.tracker.reserve(Math.max(0, estimateMicros));
  }
}
