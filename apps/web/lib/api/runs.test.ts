import type { AppEvent, RunDetail, Step, Task } from "@bs-job-agents/shared";
import { runFixture, stepFixture, taskFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { applyRunEvent, mergeRunDetail, stepPreview, type RunView } from "./runs";

const at = "2026-10-10T09:30:00+07:00";
const step = (over: Partial<Step> & { preview?: string | null } = {}) => ({ ...stepFixture, ...over });
const view = (steps: RunView["steps"], tasks: Task[] = []): RunView => ({ run: runFixture, steps, tasks });

describe("applyRunEvent: live patches before the re-read", () => {
  it("step.updated sets status, round, preview and counts on the matching step", () => {
    const before = view([step({ id: "s1", status: "pending", preview: null })]);
    const e: AppEvent = {
      id: "1",
      at,
      type: "step.updated",
      runId: "run_13",
      stepId: "s1",
      stepKey: "tailor",
      branchKey: "job_1",
      status: "running",
      round: 2,
      preview: "CV EN round 2",
      counts: null,
    };
    const after = applyRunEvent(before, e);
    expect(after.steps[0]).toMatchObject({ status: "running", round: 2, preview: "CV EN round 2" });
    expect(before.steps[0]!.status).toBe("pending");
  });

  it("an event for a step not read yet adds it (the canvas shows it at once)", () => {
    const e: AppEvent = { id: "2", at, type: "step.started", runId: "run_13", stepId: "s9", stepKey: "company", branchKey: "101", round: null };
    const after = applyRunEvent(view([]), e);
    expect(after.steps).toEqual([expect.objectContaining({ id: "s9", stepKey: "company", branchKey: "101", status: "running", startedAt: at })]);
  });

  it("step.finished keeps the last preview when the event has none", () => {
    const before = view([step({ id: "s1", status: "running", preview: "QA reviewing" })]);
    const e: AppEvent = { id: "3", at, type: "step.finished", runId: "run_13", stepId: "s1", stepKey: "tailor", branchKey: "job_1", status: "done", preview: null, error: null };
    expect(applyRunEvent(before, e).steps[0]).toMatchObject({ status: "done", preview: "QA reviewing", finishedAt: at });
  });

  it("task events update the task's status and pause reason", () => {
    const before = view([step()], [{ ...taskFixture, id: "t1", status: "running" }]);
    const paused = applyRunEvent(before, {
      id: "4",
      at,
      type: "task.paused",
      taskId: "t1",
      runId: "run_13",
      botName: "cv",
      reason: { code: "needs_figma", site: null, detail: null },
    });
    expect(paused.tasks[0]).toMatchObject({ status: "paused", pauseReason: { code: "needs_figma" } });
    const done = applyRunEvent(paused, { id: "5", at, type: "task.finished", taskId: "t1", runId: "run_13", stepId: "step_7", botName: "cv", status: "done", attempt: 1, error: null });
    expect(done.tasks[0]).toMatchObject({ status: "done", pauseReason: null, finishedAt: at });
  });

  it("run events update the run's status", () => {
    const after = applyRunEvent(view([]), { id: "6", at, type: "run.updated", runId: "run_13", status: "paused" });
    expect(after.run.status).toBe("paused");
    const finished = applyRunEvent(after, { id: "7", at, type: "run.finished", runId: "run_13", status: "cancelled", summary: null });
    expect(finished.run).toMatchObject({ status: "cancelled", finishedAt: at });
  });

  it("ignores events of other runs", () => {
    const before = view([step({ id: "s1" })]);
    expect(applyRunEvent(before, { id: "8", at, type: "run.updated", runId: "other", status: "paused" })).toBe(before);
  });
});

describe("mergeRunDetail", () => {
  it("keeps previews the server does not send (W3a handoff) from the live events", () => {
    const prev = view([step({ id: "s1", preview: "34 found → 21 new" })]);
    const next: RunDetail = { run: runFixture, steps: [step({ id: "s1", status: "done" })], tasks: [] };
    expect(mergeRunDetail(prev, next).steps[0]).toMatchObject({ status: "done", preview: "34 found → 21 new" });
    expect(mergeRunDetail(undefined, next).steps[0]!.preview).toBeNull();
  });
});

describe("stepPreview: a preview from the step's output when no event gave one", () => {
  it("map counts, filter items, gate rounds, review and apply outcomes", () => {
    expect(stepPreview(step({ stepKey: "scan", output: { counts: { total: 3, queued: 0, running: 1, done: 2, failed: 0 } } }))).toBe("2/3 done · 1 running");
    expect(stepPreview(step({ stepKey: "top", output: { items: [{ jobId: 1 }, { jobId: 2 }] } }))).toBe("2 jobs");
    expect(
      stepPreview(
        step({ stepKey: "tailor", output: { rounds: [{ total: 72, passed: false }, { total: 88, passed: true }], outcome: "passed", language: "en" } }),
      ),
    ).toBe("QA 72 → 88 · passed");
    expect(stepPreview(step({ stepKey: "tailor", output: { rounds: [{ total: 70 }, { total: 74 }, { total: 76 }], outcome: "escalated" } }))).toBe(
      "QA 70 → 74 → 76 · not passed",
    );
    expect(stepPreview(step({ stepKey: "review", status: "waiting", output: { escalated: true } }))).toBe("QA not passed · Ba decides");
    expect(stepPreview(step({ stepKey: "review", status: "waiting", output: {} }))).toBe("waiting for Ba");
    expect(stepPreview(step({ stepKey: "apply", status: "locked", output: null }))).toBe("unlocks after approval");
    expect(stepPreview(step({ stepKey: "apply", status: "done", output: { outcome: "submitted" } }))).toBe("submitted");
    expect(stepPreview(step({ stepKey: "company", status: "skipped", output: { cacheHit: true } }))).toBe("cache hit");
    expect(stepPreview(step({ preview: "given" }))).toBe("given");
  });
});
