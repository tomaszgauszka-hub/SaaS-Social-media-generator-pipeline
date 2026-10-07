import type {
  CreativeQaReport,
  GateResult,
  QualityThresholds,
  QualityVerdict,
  SimpleQaReport,
  TechnicalQaReport,
} from "./types.ts";
import { DEFAULT_THRESHOLDS } from "./types.ts";

/**
 * Quality gates (spec §41): Technical PASS · Creative ≥ 80 (no hard fails) · Factual ≥ 95 · Compliance PASS ·
 * Localization ≥ 90 — all configurable. Placeholder / demo media can pass every gate and is still
 * NOT PRODUCTION READY (spec §44).
 */
export function evaluateGates(input: {
  technical: TechnicalQaReport;
  creative: CreativeQaReport;
  factual: SimpleQaReport;
  compliance: SimpleQaReport;
  localization: SimpleQaReport;
  flags: { placeholderMedia: boolean; demoOnly: boolean };
  thresholds?: Partial<QualityThresholds>;
}): QualityVerdict {
  const t = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const gates: GateResult[] = [
    {
      gate: "technical",
      pass: input.technical.status === "PASS",
      value: input.technical.status,
      required: "PASS",
    },
    {
      gate: "creative",
      pass: input.creative.score >= t.creativeMin && input.creative.hardFails.length === 0,
      value: `${input.creative.score}${input.creative.hardFails.length ? ` (${input.creative.hardFails.length} hard fail)` : ""}`,
      required: `≥ ${t.creativeMin}, no hard fails`,
    },
    {
      gate: "factual",
      pass: input.factual.score >= t.factualMin,
      value: `${input.factual.score}`,
      required: `≥ ${t.factualMin}`,
    },
    {
      gate: "compliance",
      pass: input.compliance.status === "PASS",
      value: input.compliance.status,
      required: "PASS",
    },
    {
      gate: "localization",
      pass: input.localization.score >= t.localizationMin,
      value: `${input.localization.score}`,
      required: `≥ ${t.localizationMin}`,
    },
  ];
  const allGatesPass = gates.every((g) => g.pass);
  const placeholder = input.flags.placeholderMedia || input.flags.demoOnly;
  const reasons = gates.filter((g) => !g.pass).map((g) => `${g.gate} gate: ${g.value} (needs ${g.required})`);
  if (placeholder) reasons.push("Contains placeholder / demo media — never production ready");
  return {
    gates,
    allGatesPass,
    productionReady: allGatesPass && !placeholder,
    label: placeholder ? "NOT_PRODUCTION_READY" : allGatesPass ? "PRODUCTION_READY" : "NEEDS_WORK",
    reasons,
  };
}
