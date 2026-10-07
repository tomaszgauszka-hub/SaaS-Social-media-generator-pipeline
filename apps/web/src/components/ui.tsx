import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-zinc-500">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {title || actions ? (
        <div className="flex items-center justify-between gap-2 border-b border-zinc-100 px-4 py-3">
          {title ? <h2 className="text-sm font-semibold text-zinc-800">{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

const TONES = {
  gray: "bg-zinc-100 text-zinc-700",
  blue: "bg-sky-100 text-sky-800",
  indigo: "bg-indigo-100 text-indigo-800",
  green: "bg-emerald-100 text-emerald-800",
  amber: "bg-amber-100 text-amber-900",
  red: "bg-rose-100 text-rose-800",
  violet: "bg-violet-100 text-violet-800",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({
  tone = "gray",
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  IDEA: "gray",
  RESEARCHING: "blue",
  SCRIPTING: "blue",
  ASSET_PLANNING: "blue",
  GENERATING_ASSETS: "blue",
  RENDERING: "blue",
  QA: "blue",
  WAITING_APPROVAL: "amber",
  APPROVED: "indigo",
  SCHEDULED: "indigo",
  PUBLISHING: "violet",
  PUBLISHED: "green",
  ANALYTICS_PENDING: "green",
  ARCHIVED: "gray",
  REJECTED: "red",
  FAILED: "red",
  BUDGET_BLOCKED: "red",
  // jobs / publications / variants
  QUEUED: "gray",
  DISPATCHED: "blue",
  RUNNING: "blue",
  RETRYING: "amber",
  SUCCEEDED: "green",
  DEAD_LETTER: "red",
  CANCELLED: "gray",
  READY: "amber",
  PENDING: "gray",
  SKIPPED: "gray",
  ACTIVE: "green",
  PAUSED: "amber",
  CONNECTED: "green",
  MOCK: "violet",
  NEEDS_REAUTH: "red",
  DISCONNECTED: "gray",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "gray"}>{status.replace(/_/g, " ").toLowerCase()}</Badge>;
}

export function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "good" | "bad" | "neutral";
}) {
  const color = tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-rose-700" : "text-zinc-900";
  return (
    <div className="card px-4 py-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums sm:text-2xl ${color}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-zinc-500">{hint}</div> : null}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-10 text-center">
      <p className="font-semibold text-zinc-700">{title}</p>
      {children ? <div className="mt-2 text-sm text-zinc-500">{children}</div> : null}
    </div>
  );
}

export function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-zinc-100">
        <thead className="bg-zinc-50">
          <tr>{head}</tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">{children}</tbody>
      </table>
    </div>
  );
}

export function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap ${active ? "bg-zinc-900 text-white" : "bg-white text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-100"}`}
    >
      {children}
    </Link>
  );
}

export function Dl({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-zinc-500">{k}</dt>
          <dd className="min-w-0 break-words text-zinc-900">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SimulatedNote({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="mb-4 rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-800">
      Includes <strong>simulated</strong> impressions, clicks and conversions from MOCK MODE — real decisions
      never learn from them.
    </p>
  );
}

/** Budget meter: fill carries severity, track is a lighter step of the same ramp; state also as icon + label. */
export function BudgetMeter({
  label,
  spent,
  limit,
  format,
}: {
  label: string;
  spent: number;
  limit: number | null;
  format: (v: number) => string;
}) {
  if (limit === null || limit <= 0) {
    return (
      <div className="text-sm">
        <div className="flex justify-between gap-2">
          <span className="text-zinc-600">{label}</span>
          <span className="tabular-nums">{format(spent)} · no limit</span>
        </div>
      </div>
    );
  }
  const ratio = spent / limit;
  const state =
    ratio >= 1
      ? { fill: "#d03b3b", track: "#f6d4d4", icon: "✕", text: "Limit reached" }
      : ratio >= 0.8
        ? { fill: "#fab219", track: "#fdecc4", icon: "⚠", text: "Near limit" }
        : { fill: "#2a78d6", track: "#cde2fb", icon: "✓", text: "Within budget" };
  return (
    <div className="text-sm">
      <div className="mb-1 flex flex-wrap justify-between gap-2">
        <span className="text-zinc-600">{label}</span>
        <span className="tabular-nums">
          {format(spent)} / {format(limit)}
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full"
        style={{ background: state.track }}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={spent}
        aria-label={label}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.min(100, ratio * 100)}%`, background: state.fill }}
        />
      </div>
      <div className="mt-1 text-xs text-zinc-500">
        <span aria-hidden>{state.icon}</span> {state.text} ({Math.round(ratio * 100)}%)
      </div>
    </div>
  );
}
