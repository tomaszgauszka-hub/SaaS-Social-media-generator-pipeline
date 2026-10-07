import { BudgetBlockedError, NotFoundError, StateConflictError, ValidationError } from "@cre/shared";
import { AuthorizationError } from "./auth";

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** Map domain errors to messages the owner can act on (never leak stack traces or secrets). */
export function toActionError(err: unknown): ActionResult {
  if (err instanceof AuthorizationError) return { ok: false, message: err.message };
  if (err instanceof BudgetBlockedError) return { ok: false, message: `Blocked by budget: ${err.message}` };
  if (err instanceof StateConflictError)
    return { ok: false, message: `This item changed meanwhile (${err.message}). Refresh and try again.` };
  if (err instanceof ValidationError || err instanceof NotFoundError)
    return { ok: false, message: err.message };
  console.error(err);
  return { ok: false, message: "Something went wrong — see the server log." };
}
