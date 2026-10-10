import { describe, expect, it } from "vitest";
import { APPLICATION_STATUSES, TASK_STATUSES, statusMeta } from "./status";

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
