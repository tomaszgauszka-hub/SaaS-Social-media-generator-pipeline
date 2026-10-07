import type { ProfitRow } from "@cre/core";
import { Table } from "@/components/ui";
import { num, pct, usd } from "@/lib/format";

/** Profitability rows with an inline profit bar (one hue; negative values in the critical red, labelled). */
export function ProfitTable({
  rows,
  label,
  limit = 12,
  linkPrefix,
}: {
  rows: ProfitRow[];
  label: string;
  limit?: number;
  linkPrefix?: string;
}) {
  const shown = rows.slice(0, limit);
  const maxAbs = Math.max(1, ...shown.map((r) => Math.abs(r.profitMicros)));
  if (shown.length === 0) return <p className="text-sm text-zinc-500">No data in this period.</p>;
  return (
    <Table
      head={
        <>
          <th className="th">{label}</th>
          <th className="th hidden sm:table-cell">Impr.</th>
          <th className="th hidden md:table-cell">Clicks</th>
          <th className="th hidden md:table-cell">Conv.</th>
          <th className="th">Revenue</th>
          <th className="th hidden sm:table-cell">Cost</th>
          <th className="th">Profit</th>
        </>
      }
    >
      {shown.map((r) => (
        <tr key={r.key}>
          <td className="td max-w-56">
            {linkPrefix ? (
              <a href={`${linkPrefix}${r.key}`} className="block truncate hover:underline">
                {r.label}
              </a>
            ) : (
              <span className="block truncate">{r.label}</span>
            )}
            <span className="text-xs text-zinc-500">
              CTR {pct(r.impressions ? r.clicks / r.impressions : null, 2)} · ROI {pct(r.roi, 0)}
            </span>
          </td>
          <td className="td hidden tabular-nums sm:table-cell">{num(r.impressions)}</td>
          <td className="td hidden tabular-nums md:table-cell">{num(r.clicks)}</td>
          <td className="td hidden tabular-nums md:table-cell">{num(r.conversions)}</td>
          <td className="td tabular-nums">{usd(r.revenueMicros)}</td>
          <td className="td hidden tabular-nums sm:table-cell">{usd(r.aiCostMicros + r.otherCostMicros)}</td>
          <td className="td">
            <span className={`block font-semibold tabular-nums ${r.profitMicros < 0 ? "text-rose-700" : ""}`}>
              {usd(r.profitMicros)}
            </span>
            <span className="mt-1 block h-1.5 w-24 rounded-full bg-[#cde2fb]" aria-hidden>
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${(Math.abs(r.profitMicros) / maxAbs) * 100}%`,
                  background: r.profitMicros < 0 ? "#d03b3b" : "#2a78d6",
                }}
              />
            </span>
          </td>
        </tr>
      ))}
    </Table>
  );
}
