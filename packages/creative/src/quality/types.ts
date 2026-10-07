/**
 * Quality reports (spec §38–§45). Technical, Creative, Factual, Compliance and Localization QA are separate
 * reports with separate gates — a technically perfect file can still be a weak creative, and vice versa.
 */
export type CheckStatus = "pass" | "warn" | "fail";

export interface QaCheck {
  id: string;
  label: string;
  status: CheckStatus;
  value?: string;
  expected?: string;
  detail?: string;
}

export interface Segment {
  startMs: number;
  endMs: number;
}

export interface TechnicalMetrics {
  durationMs: number;
  expectedDurationMs: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  pixFmt: string;
  audioCodec: string;
  audioSampleRate: number;
  audioChannels: number;
  sizeBytes: number;
  bitRate: number;
  integratedLufs: number | null;
  truePeakDb: number | null;
  loudnessRange: number | null;
  blackSegments: Segment[];
  blankSamples: number;
  /** identical frames (a stalled or frozen picture) */
  frozenSegments: Segment[];
  /** visually unchanged stretches ≥ 2.5 s (frame vs frame 2.5 s later) — a creative, not a technical, defect */
  staticSegments: Segment[];
  silenceSegments: Segment[];
  decodeErrors: number;
  sceneCuts: number;
  /** mean frame-to-frame difference (0–255) of the 10 fps proxy */
  avgMotion: number;
  beats: { beatId: string; motion: number; hash: string; meanLuma: number }[];
}

export interface TechnicalQaReport {
  version: 1;
  status: "PASS" | "FAIL";
  checks: QaCheck[];
  metrics: TechnicalMetrics;
  analysisMs: number;
}

export interface QualityFactor {
  id: string;
  label: string;
  score: number;
  weight: number;
  notes: string[];
}

export interface CreativeMetrics {
  /** share of the reel showing product, detail, demonstration, context, diagram, UI or comparison (0–1) */
  meaningfulVisualCoverage: number;
  /** share of the reel where the frame is essentially text on a background (0–1) */
  textOnlyDurationRatio: number;
  /** 0–100, 100 = every beat visually distinct */
  visualRepetition: number;
  /** longest visually unchanged stretch (ms) */
  longestStaticMs: number;
}

export interface CreativeQaReport {
  version: 1;
  score: number;
  metrics: CreativeMetrics;
  factors: QualityFactor[];
  /** hard rules — any failure caps the score and fails the creative gate */
  hardFails: string[];
  warnings: string[];
}

export interface SimpleQaReport {
  version: 1;
  score: number;
  status: "PASS" | "FAIL";
  checks: QaCheck[];
}

export interface QualityThresholds {
  creativeMin: number;
  factualMin: number;
  localizationMin: number;
  /** technical and compliance are pass/fail */
}

export const DEFAULT_THRESHOLDS: QualityThresholds = { creativeMin: 80, factualMin: 95, localizationMin: 90 };

export interface GateResult {
  gate: "technical" | "creative" | "factual" | "compliance" | "localization";
  pass: boolean;
  value: string;
  required: string;
}

export interface QualityVerdict {
  gates: GateResult[];
  allGatesPass: boolean;
  /** never true for placeholder / demo media, whatever the scores */
  productionReady: boolean;
  label: "PRODUCTION_READY" | "NEEDS_WORK" | "NOT_PRODUCTION_READY";
  reasons: string[];
}
