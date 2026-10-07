import { describe, expect, it } from "vitest";
import { InvalidTransitionError } from "@cre/shared";
import { ContentStatus, JobStatus, PublicationStatus, VariantStatus } from "@cre/db/enums";
import {
  contentMachine,
  isValidResumeTarget,
  jobMachine,
  publicationMachine,
  regenerationEntryState,
  variantMachine,
} from "./state-machine.ts";

describe("content lifecycle", () => {
  it("allows the happy path IDEA → … → ARCHIVED", () => {
    const path: ContentStatus[] = [
      "IDEA",
      "RESEARCHING",
      "SCRIPTING",
      "ASSET_PLANNING",
      "GENERATING_ASSETS",
      "RENDERING",
      "QA",
      "WAITING_APPROVAL",
      "APPROVED",
      "SCHEDULED",
      "PUBLISHING",
      "PUBLISHED",
      "ANALYTICS_PENDING",
      "ARCHIVED",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(contentMachine.can(path[i]!, path[i + 1]!), `${path[i]} → ${path[i + 1]}`).toBe(true);
    }
  });

  it("rejects skipping steps and leaving terminal states", () => {
    expect(contentMachine.can("IDEA", "RENDERING")).toBe(false);
    expect(contentMachine.can("SCRIPTING", "WAITING_APPROVAL")).toBe(false);
    expect(contentMachine.can("WAITING_APPROVAL", "PUBLISHED")).toBe(false);
    expect(contentMachine.can("ARCHIVED", "IDEA")).toBe(false);
    expect(contentMachine.isTerminal("ARCHIVED")).toBe(true);
    expect(() => contentMachine.assert("QA", "PUBLISHED")).toThrow(InvalidTransitionError);
  });

  it("cannot be approved without passing through QA / waiting approval", () => {
    for (const s of ["RENDERING", "GENERATING_ASSETS", "QA", "REJECTED"] as ContentStatus[]) {
      expect(contentMachine.can(s, "APPROVED")).toBe(false);
    }
  });

  it("QA can auto-reject", () => {
    expect(contentMachine.can("QA", "REJECTED")).toBe(true);
  });

  it("paid steps can become BUDGET_BLOCKED and resume", () => {
    for (const s of [
      "RESEARCHING",
      "SCRIPTING",
      "ASSET_PLANNING",
      "GENERATING_ASSETS",
      "QA",
    ] as ContentStatus[]) {
      expect(contentMachine.can(s, "BUDGET_BLOCKED")).toBe(true);
      expect(isValidResumeTarget("BUDGET_BLOCKED", s)).toBe(true);
    }
    // rendering is local (no paid API) → never budget-blocked
    expect(contentMachine.can("RENDERING", "BUDGET_BLOCKED")).toBe(false);
    expect(isValidResumeTarget("BUDGET_BLOCKED", "PUBLISHED")).toBe(false);
  });

  it("failed work can be retried at the failed step", () => {
    expect(isValidResumeTarget("FAILED", "RENDERING")).toBe(true);
    expect(isValidResumeTarget("FAILED", "SCHEDULED")).toBe(true);
    expect(isValidResumeTarget("FAILED", "APPROVED")).toBe(false);
  });

  it("every enum value has a transition entry", () => {
    for (const s of Object.values(ContentStatus)) expect(contentMachine.transitions[s]).toBeDefined();
    for (const s of Object.values(VariantStatus)) expect(variantMachine.transitions[s]).toBeDefined();
    for (const s of Object.values(PublicationStatus)) expect(publicationMachine.transitions[s]).toBeDefined();
    for (const s of Object.values(JobStatus)) expect(jobMachine.transitions[s]).toBeDefined();
  });

  it("transition targets are valid states", () => {
    const all = new Set(Object.values(ContentStatus));
    for (const targets of Object.values(contentMachine.transitions)) {
      for (const t of targets) expect(all.has(t)).toBe(true);
    }
  });
});

describe("regeneration", () => {
  it("re-enters the pipeline only as far back as needed", () => {
    expect(regenerationEntryState("ENTIRE")).toBe("RESEARCHING");
    expect(regenerationEntryState("SCRIPT")).toBe("SCRIPTING");
    expect(regenerationEntryState("HOOK")).toBe("SCRIPTING");
    expect(regenerationEntryState("CAPTION")).toBe("SCRIPTING");
    expect(regenerationEntryState("IMAGE")).toBe("GENERATING_ASSETS");
    expect(regenerationEntryState("VIDEO_SCENE")).toBe("GENERATING_ASSETS");
    expect(regenerationEntryState("VOICE")).toBe("GENERATING_ASSETS");
  });

  it("regeneration targets are reachable from WAITING_APPROVAL and REJECTED", () => {
    for (const scope of ["ENTIRE", "SCRIPT", "HOOK", "CAPTION", "IMAGE", "VIDEO_SCENE", "VOICE"] as const) {
      const target = regenerationEntryState(scope);
      expect(contentMachine.can("WAITING_APPROVAL", target)).toBe(true);
      expect(contentMachine.can("REJECTED", target)).toBe(true);
    }
  });
});

describe("variant / publication / job machines", () => {
  it("variant approval flow", () => {
    expect(variantMachine.can("READY", "APPROVED")).toBe(true);
    expect(variantMachine.can("APPROVED", "SCHEDULED")).toBe(true);
    expect(variantMachine.can("PENDING", "APPROVED")).toBe(false);
    expect(variantMachine.can("PUBLISHED", "SCHEDULED")).toBe(false);
  });

  it("publication flow and retry", () => {
    expect(publicationMachine.can("SCHEDULED", "PUBLISHING")).toBe(true);
    expect(publicationMachine.can("PUBLISHING", "PUBLISHED")).toBe(true);
    expect(publicationMachine.can("FAILED", "SCHEDULED")).toBe(true);
    expect(publicationMachine.isTerminal("PUBLISHED")).toBe(true);
    expect(publicationMachine.can("PUBLISHED", "PUBLISHING")).toBe(false);
  });

  it("job flow: budget-blocked jobs are never retried automatically", () => {
    expect(jobMachine.can("RUNNING", "BUDGET_BLOCKED")).toBe(true);
    expect(jobMachine.can("BUDGET_BLOCKED", "RUNNING")).toBe(false);
    expect(jobMachine.can("BUDGET_BLOCKED", "QUEUED")).toBe(true);
    expect(jobMachine.can("DEAD_LETTER", "QUEUED")).toBe(true);
    expect(jobMachine.isTerminal("SUCCEEDED")).toBe(true);
  });
});
