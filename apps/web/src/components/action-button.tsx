"use client";

import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/action-result";

/** Button that runs a (bound) server action and shows its result inline. */
export function ActionButton({
  action,
  label,
  pendingLabel,
  confirm,
  className = "btn-secondary",
}: {
  action: () => Promise<ActionResult>;
  label: string;
  pendingLabel?: string;
  confirm?: string;
  className?: string;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        className={className}
        disabled={pending}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          start(async () => setResult(await action()));
        }}
      >
        {pending ? (pendingLabel ?? "Working…") : label}
      </button>
      {result ? (
        <span role="status" className={`text-xs ${result.ok ? "text-emerald-700" : "text-rose-700"}`}>
          {result.message}
        </span>
      ) : null}
    </span>
  );
}
