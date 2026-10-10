import { beforeEach, describe, expect, it } from "vitest";
import { openTestDb, type Db } from "../client.js";
import { at, seedBots, T0 } from "../test-helpers.js";
import {
  createRun,
  createStep,
  getRun,
  getStep,
  getStepByKey,
  listActiveRuns,
  listRuns,
  listSteps,
  resetStep,
  updateRunStatus,
  updateStepStatus,
} from "./runs.js";
import { NotFoundError } from "../errors.js";

let db: Db;
beforeEach(() => {
  db = openTestDb();
  seedBots(db);
});

describe("runs", () => {
  it("creates a run with params and defaults to running", () => {
    const run = createRun(
      db,
      { workflowName: "job-scan", workflowVersion: 1, trigger: "schedule", params: { maxJobs: 5 } },
      { now: T0 },
    );
    expect(run).toMatchObject({
      workflowName: "job-scan",
      trigger: "schedule",
      status: "running",
      params: { maxJobs: 5 },
      createdAt: T0.toISOString(),
      finishedAt: null,
    });
    expect(getRun(db, run.id)).toEqual(run);
    expect(getRun(db, 9999)).toBeUndefined();
  });

  it("sets finished_at on terminal statuses and records an error", () => {
    const run = createRun(db, { workflowName: "w", workflowVersion: 1, trigger: "chat", params: {} });
    const paused = updateRunStatus(db, run.id, "paused", { now: at(1) });
    expect(paused.finishedAt).toBeNull();
    const failed = updateRunStatus(db, run.id, "failed", { now: at(2), error: "TopCV adapter broken" });
    expect(failed).toMatchObject({ status: "failed", finishedAt: at(2).toISOString(), error: "TopCV adapter broken" });
  });

  it("remembers the Search Profile version the run started with (UC-21b)", () => {
    const run = createRun(db, { workflowName: "job-scan", workflowVersion: 1, trigger: "chat", params: {}, searchProfileVersion: 3 });
    expect(getRun(db, run.id)?.searchProfileVersion).toBe(3);
    expect(createRun(db, { workflowName: "apply-to-link", workflowVersion: 1, trigger: "link", params: {} }).searchProfileVersion).toBeNull();
  });

  it("throws NotFoundError for unknown runs", () => {
    expect(() => updateRunStatus(db, 42, "done")).toThrow(NotFoundError);
  });

  it("lists runs newest first, filtered by status, and the active ones", () => {
    const a = createRun(db, { workflowName: "w", workflowVersion: 1, trigger: "chat", params: {} }, { now: at(1) });
    const b = createRun(db, { workflowName: "w", workflowVersion: 1, trigger: "link", params: {} }, { now: at(2) });
    const c = createRun(db, { workflowName: "w", workflowVersion: 1, trigger: "chat", params: {} }, { now: at(3) });
    updateRunStatus(db, b.id, "done");
    updateRunStatus(db, c.id, "waiting");
    expect(listRuns(db).map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect(listRuns(db, { status: "done" }).map((r) => r.id)).toEqual([b.id]);
    expect(listRuns(db, { limit: 1 }).map((r) => r.id)).toEqual([c.id]);
    expect(listActiveRuns(db).map((r) => r.id).sort()).toEqual([a.id, c.id].sort());
  });
});

describe("steps", () => {
  it("creates steps keyed by run, step key and branch", () => {
    const run = createRun(db, { workflowName: "w", workflowVersion: 1, trigger: "chat", params: {} });
    const scan = createStep(db, { runId: run.id, stepKey: "scan" });
    const cv1 = createStep(db, { runId: run.id, stepKey: "cv", branchKey: "job-1" });
    const cv2 = createStep(db, { runId: run.id, stepKey: "cv", branchKey: "job-2" });
    expect(scan).toMatchObject({ status: "pending", branchKey: "" });
    expect(getStepByKey(db, run.id, "cv", "job-2")?.id).toBe(cv2.id);
    expect(getStepByKey(db, run.id, "scan")?.id).toBe(scan.id);
    expect(listSteps(db, run.id).map((s) => s.id)).toEqual([scan.id, cv1.id, cv2.id]);
    expect(() => createStep(db, { runId: run.id, stepKey: "cv", branchKey: "job-1" })).toThrow();
  });

  it("tracks started_at / finished_at and persists output", () => {
    const run = createRun(db, { workflowName: "w", workflowVersion: 1, trigger: "chat", params: {} });
    const step = createStep(db, { runId: run.id, stepKey: "scan" });
    const running = updateStepStatus(db, step.id, "running", { now: at(1) });
    expect(running.startedAt).toBe(at(1).toISOString());
    const done = updateStepStatus(db, step.id, "done", { now: at(5), output: { jobs: [1, 2] } });
    expect(done).toMatchObject({ startedAt: at(1).toISOString(), finishedAt: at(5).toISOString(), output: { jobs: [1, 2] } });
    expect(getStep(db, step.id)?.output).toEqual({ jobs: [1, 2] });
  });

  it("stores the gate round and the shared locked / paused node states (§7.2 step 7, §11)", () => {
    const run = createRun(db, { workflowName: "w", workflowVersion: 1, trigger: "chat", params: {} });
    const gate = createStep(db, { runId: run.id, stepKey: "tailor", branchKey: "job-1", round: 1 });
    expect(gate.round).toBe(1);
    expect(updateStepStatus(db, gate.id, "running", { round: 2 }).round).toBe(2);
    const apply = createStep(db, { runId: run.id, stepKey: "apply", branchKey: "job-1", status: "locked" });
    expect(apply.status).toBe("locked");
    expect(updateStepStatus(db, apply.id, "paused", { now: at(1) })).toMatchObject({ status: "paused", finishedAt: null });
    expect(() => db.$client.prepare("UPDATE steps SET status = 'stuck' WHERE id = ?").run(apply.id)).toThrow(/CHECK/);
  });

  it("resets a step for re-run (UC-23)", () => {
    const run = createRun(db, { workflowName: "w", workflowVersion: 1, trigger: "chat", params: {} });
    const step = createStep(db, { runId: run.id, stepKey: "cv" });
    updateStepStatus(db, step.id, "failed", { error: "boom", output: { x: 1 } });
    expect(resetStep(db, step.id)).toMatchObject({ status: "pending", output: null, error: null, startedAt: null, finishedAt: null });
  });
});
