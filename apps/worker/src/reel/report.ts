import path from "node:path";
import type { ProduceResult } from "@cre/reel";

/** Markdown report of one reel job: economics, variants, stage timings, fallbacks, QA issues. */
export function renderReelReport(r: ProduceResult, wallMs: number, google: boolean): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const lines = [
    `# Reel job ${r.jobId}`,
    "",
    `Wall time ${s(wallMs)} · API cost $${r.totalApiCostUsd.toFixed(4)} · Google AI ${google ? "configured" : "not configured (local fallbacks)"}`,
    `Bottleneck: **${r.bottleneck.stage}** ${s(r.bottleneck.ms)} (${Math.round(r.bottleneck.share * 100)} % of stage time)`,
    "",
    "## Unit economics",
    "",
    `- reels delivered: ${r.economics.reels} · API $${r.economics.apiUsd.toFixed(4)} · host ${(r.economics.computeHours * 60).toFixed(1)} min ≈ $${r.economics.computeUsd.toFixed(4)}`,
    `- total $${r.economics.totalUsd.toFixed(4)} → **$${r.economics.perReelUsd.toFixed(4)} per reel**`,
    r.economics.breakEvenSales !== undefined
      ? `- commission $${r.economics.commissionPerSaleUsd!.toFixed(2)} per sale → pays back after **${r.economics.breakEvenSales} sale(s)**`
      : "- payback: pass --commission-rate or --commission-usd to estimate break-even sales",
    "",
    "| Variant | Locale | Platform | Duration | QA | Passed | Master reused | API cost | Director | Music | Voice | Video |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...r.variants.map((v) => {
      const m = v.manifest;
      return `| ${v.variantKey} | ${v.locale} | ${v.platform} | ${s(m.durationMs)} | ${Math.round(m.qa.score)} | ${m.qa.passed ? "yes" : "no"} | ${m.masterVideo.reused ? "yes" : "no"} | $${m.totalApiCostUsd.toFixed(4)} | ${m.providers.director} | ${m.providers.musicProvider} | ${m.providers.voiceProvider} | ${path.basename(v.video)} |`;
    }),
    "",
    "## Stage timings",
    "",
    ...Object.entries(r.timings)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `- ${k}: ${s(v)}`),
    "",
    "## Fallbacks",
    "",
    ...(r.fallbacks.length
      ? r.fallbacks.map((f) => `- ${f.capability}: ${f.wanted} → ${f.used} (${f.reason})`)
      : ["- none"]),
    "",
    "## QA issues",
    "",
    ...r.variants.flatMap((v) =>
      v.manifest.qa.issues.length
        ? v.manifest.qa.issues.map(
            (i) => `- ${v.variantKey} ${v.locale} ${v.platform} ${i.severity} ${i.code}: ${i.message}`,
          )
        : [`- ${v.variantKey} ${v.locale} ${v.platform}: none`],
    ),
    "",
  ];
  return lines.join("\n");
}
