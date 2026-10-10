import { describe, expect, it } from "vitest";
import {
  NON_RETRYABLE_TASKS,
  OUTWARD_FACING_TASK_KEYS,
  isKnownTaskKind,
  isOutwardFacingTask,
  isRetryableTask,
  splitTaskKey,
  taskKey,
} from "./tasks.js";

describe("task keys (§5.3, §7.1; PM S2, S4)", () => {
  it("joins and splits <bot>.<kind>", () => {
    expect(taskKey("apply", "submit")).toBe("apply.submit");
    expect(splitTaskKey("research.company")).toEqual({ botName: "research", kind: "company" });
    expect(splitTaskKey("nodot")).toBeNull();
    expect(splitTaskKey(".x")).toBeNull();
  });

  it("apply.submit is the one outward-facing task in Phase 1", () => {
    expect([...OUTWARD_FACING_TASK_KEYS]).toEqual(["apply.submit"]);
    expect(isOutwardFacingTask("apply", "submit")).toBe(true);
    expect(isOutwardFacingTask("research", "scan")).toBe(false);
    expect(isOutwardFacingTask("cv", "tailor")).toBe(false);
  });

  it("apply.submit is never retried or restarted automatically (PM FYI c, UC-18)", () => {
    expect(isRetryableTask("apply", "submit")).toBe(false);
    expect(isRetryableTask("research", "scan")).toBe(true);
    expect(NON_RETRYABLE_TASKS).toEqual([{ botName: "apply", kind: "submit" }]);
  });

  it("knows each Phase 1 bot's kinds; other bots are not checked", () => {
    expect(isKnownTaskKind("research", "fit")).toBe(true);
    expect(isKnownTaskKind("research", "fitt")).toBe(false);
    expect(isKnownTaskKind("qa", "tailor")).toBe(false);
    expect(isKnownTaskKind("lead", "chat")).toBe(true);
    expect(isKnownTaskKind("translator", "anything")).toBeNull();
  });
});
