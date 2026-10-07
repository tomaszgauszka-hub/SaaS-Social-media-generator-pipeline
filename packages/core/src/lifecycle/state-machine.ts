import { InvalidTransitionError } from "@cre/shared";
import type {
  ContentStatus,
  JobStatus,
  PublicationStatus,
  RegenerationScope,
  VariantStatus,
} from "@cre/db/enums";

/**
 * Explicit, table-driven state machines. Every status change in the system goes through `assert`
 * (or the DB helpers in transitions.ts which call it).
 */
export interface StateMachine<S extends string> {
  readonly entity: string;
  readonly transitions: Readonly<Record<S, readonly S[]>>;
  can(from: S, to: S): boolean;
  assert(from: S, to: S): void;
  next(from: S): readonly S[];
  isTerminal(state: S): boolean;
}

export function defineStateMachine<S extends string>(
  entity: string,
  transitions: Record<S, readonly S[]>,
): StateMachine<S> {
  return {
    entity,
    transitions,
    can: (from, to) => transitions[from].includes(to),
    assert(from, to) {
      if (!transitions[from].includes(to)) throw new InvalidTransitionError(entity, from, to);
    },
    next: (from) => transitions[from],
    isTerminal: (state) => transitions[state].length === 0,
  };
}

/** States in which pipeline work is actively happening (resume targets after FAILED / BUDGET_BLOCKED). */
export const CONTENT_WORKING_STATES = [
  "RESEARCHING",
  "SCRIPTING",
  "ASSET_PLANNING",
  "GENERATING_ASSETS",
  "RENDERING",
  "QA",
] as const satisfies readonly ContentStatus[];

/** States that may require paid operations (and can therefore become BUDGET_BLOCKED). */
export const CONTENT_PAID_STATES = [
  "IDEA",
  "RESEARCHING",
  "SCRIPTING",
  "ASSET_PLANNING",
  "GENERATING_ASSETS",
  "QA",
] as const satisfies readonly ContentStatus[];

const REGENERATION_TARGETS = [
  "RESEARCHING",
  "SCRIPTING",
  "GENERATING_ASSETS",
  "RENDERING",
  "QA",
] as const satisfies readonly ContentStatus[];

export const contentMachine = defineStateMachine<ContentStatus>("ContentProject", {
  IDEA: ["RESEARCHING", "BUDGET_BLOCKED", "FAILED", "ARCHIVED"],
  RESEARCHING: ["SCRIPTING", "BUDGET_BLOCKED", "FAILED", "ARCHIVED"],
  SCRIPTING: ["ASSET_PLANNING", "BUDGET_BLOCKED", "FAILED", "ARCHIVED"],
  ASSET_PLANNING: ["GENERATING_ASSETS", "BUDGET_BLOCKED", "FAILED", "ARCHIVED"],
  GENERATING_ASSETS: ["RENDERING", "BUDGET_BLOCKED", "FAILED", "ARCHIVED"],
  RENDERING: ["QA", "FAILED", "ARCHIVED"],
  QA: ["WAITING_APPROVAL", "REJECTED", "BUDGET_BLOCKED", "FAILED", "ARCHIVED"],
  WAITING_APPROVAL: ["APPROVED", "REJECTED", ...REGENERATION_TARGETS, "ARCHIVED"],
  APPROVED: ["SCHEDULED", "WAITING_APPROVAL", "FAILED", "ARCHIVED"],
  REJECTED: [...REGENERATION_TARGETS, "WAITING_APPROVAL", "ARCHIVED"],
  SCHEDULED: ["PUBLISHING", "WAITING_APPROVAL", "FAILED", "ARCHIVED"],
  PUBLISHING: ["PUBLISHED", "SCHEDULED", "FAILED"],
  PUBLISHED: ["ANALYTICS_PENDING", "ARCHIVED"],
  ANALYTICS_PENDING: ["ARCHIVED"],
  FAILED: [...CONTENT_WORKING_STATES, "SCHEDULED", "ARCHIVED"],
  BUDGET_BLOCKED: [...CONTENT_PAID_STATES.filter((s) => s !== "IDEA"), "ARCHIVED"],
  ARCHIVED: [],
});

export const variantMachine = defineStateMachine<VariantStatus>("ContentVariant", {
  PENDING: ["READY", "FAILED", "SKIPPED", "ARCHIVED"],
  READY: ["APPROVED", "REJECTED", "SKIPPED", "PENDING", "ARCHIVED"],
  APPROVED: ["SCHEDULED", "READY", "PENDING", "SKIPPED", "ARCHIVED"],
  REJECTED: ["PENDING", "READY", "ARCHIVED"],
  SKIPPED: ["PENDING", "READY", "ARCHIVED"],
  SCHEDULED: ["PUBLISHING", "APPROVED", "READY", "ARCHIVED"],
  PUBLISHING: ["PUBLISHED", "FAILED", "SCHEDULED"],
  PUBLISHED: ["ARCHIVED"],
  FAILED: ["SCHEDULED", "PENDING", "ARCHIVED"],
  ARCHIVED: [],
});

export const publicationMachine = defineStateMachine<PublicationStatus>("Publication", {
  SCHEDULED: ["PUBLISHING", "CANCELLED"],
  PUBLISHING: ["PUBLISHED", "FAILED", "SCHEDULED"],
  FAILED: ["SCHEDULED", "CANCELLED"],
  PUBLISHED: [],
  CANCELLED: [],
});

export const jobMachine = defineStateMachine<JobStatus>("GenerationJob", {
  QUEUED: ["DISPATCHED", "RUNNING", "CANCELLED"],
  DISPATCHED: ["RUNNING", "QUEUED", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "RETRYING", "FAILED", "DEAD_LETTER", "BUDGET_BLOCKED", "QUEUED"],
  RETRYING: ["RUNNING", "DISPATCHED", "FAILED", "DEAD_LETTER", "CANCELLED"],
  FAILED: ["QUEUED", "DEAD_LETTER"],
  DEAD_LETTER: ["QUEUED"],
  BUDGET_BLOCKED: ["QUEUED", "CANCELLED"],
  SUCCEEDED: [],
  CANCELLED: [],
});

/** Where a regeneration request re-enters the pipeline. Steps are idempotent, so unchanged assets are reused. */
export function regenerationEntryState(scope: RegenerationScope): ContentStatus {
  switch (scope) {
    case "ENTIRE":
      return "RESEARCHING";
    case "SCRIPT":
    case "HOOK":
    case "CAPTION":
      return "SCRIPTING";
    case "IMAGE":
    case "VIDEO_SCENE":
    case "VOICE":
      return "GENERATING_ASSETS";
  }
}

/** Which state a FAILED / BUDGET_BLOCKED project may resume to. */
export function isValidResumeTarget(
  blockedState: "FAILED" | "BUDGET_BLOCKED",
  target: ContentStatus,
): boolean {
  return contentMachine.can(blockedState, target);
}

export function isAwaitingHuman(status: ContentStatus): boolean {
  return status === "WAITING_APPROVAL";
}
