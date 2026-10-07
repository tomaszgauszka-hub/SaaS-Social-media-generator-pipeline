"use client";

import { useActionState, type ReactNode } from "react";
import type { ActionResult } from "@/lib/action-result";

/** <form> bound to a server action `(prev, formData) => ActionResult`, with pending state and inline result. */
export function ActionForm({
  action,
  children,
  submitLabel,
  className = "space-y-4",
  submitClassName = "btn-primary",
}: {
  action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
  children: ReactNode;
  submitLabel: string;
  className?: string;
  submitClassName?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className={className}>
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={submitClassName} disabled={pending}>
          {pending ? "Working…" : submitLabel}
        </button>
        {state ? (
          <span role="status" className={`text-sm ${state.ok ? "text-emerald-700" : "text-rose-700"}`}>
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
