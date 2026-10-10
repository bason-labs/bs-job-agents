import {
  APPLICATION_STATUSES as SHARED_APPLICATION_STATUSES,
  RUN_STATUSES as SHARED_RUN_STATUSES,
  STEP_STATUSES,
  TASK_STATUSES as SHARED_TASK_STATUSES,
} from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { APPLICATION_STATUSES, RUN_STATUSES, TASK_STATUSES, hasStatusMeta, statusMeta } from "./status";

describe("status lists come from @bs-job-agents/shared", () => {
  it("re-uses the shared task and run lists; the Applications table shows shared statuses only", () => {
    expect(TASK_STATUSES).toBe(SHARED_TASK_STATUSES);
    expect(RUN_STATUSES).toBe(SHARED_RUN_STATUSES);
    for (const s of APPLICATION_STATUSES) expect(SHARED_APPLICATION_STATUSES).toContain(s);
  });

  it("has an explicit label for every shared application, run, step and task status", () => {
    const all = [...SHARED_APPLICATION_STATUSES, ...SHARED_RUN_STATUSES, ...STEP_STATUSES, ...SHARED_TASK_STATUSES];
    expect(all.filter((s) => !hasStatusMeta(s))).toEqual([]);
    expect(statusMeta("approved")).toEqual({ label: "Approved", tone: "accent" });
    expect(statusMeta("locked")).toEqual({ label: "Locked", tone: "neutral" });
  });
});

describe("statusMeta", () => {
  it("labels every application status (UC-13)", () => {
    expect(APPLICATION_STATUSES).toEqual([
      "submitted",
      "interviewing",
      "offer",
      "rejected",
      "withdrawn",
      "no_response",
      "needs_check",
    ]);
    expect(statusMeta("no_response")).toEqual({ label: "No response", tone: "neutral" });
    expect(statusMeta("needs_check").tone).toBe("warn");
    expect(statusMeta("offer").tone).toBe("ok");
    expect(statusMeta("rejected").tone).toBe("danger");
  });

  it("labels every task status (spec §9)", () => {
    expect(TASK_STATUSES).toEqual(["queued", "running", "waiting_limit", "paused", "done", "failed", "interrupted"]);
    expect(statusMeta("waiting_limit")).toEqual({ label: "Waiting for limit", tone: "warn" });
    expect(statusMeta("running")).toEqual({ label: "Running", tone: "accent", live: true });
    expect(statusMeta("failed").tone).toBe("danger");
  });

  it("falls back to a humanised neutral label for unknown statuses", () => {
    expect(statusMeta("something_new")).toEqual({ label: "Something new", tone: "neutral" });
  });
});
