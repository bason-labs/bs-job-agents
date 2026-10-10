// UC-23: pause, cancel or re-run.
// - Pause: no new tasks start; running ones finish.
// - Cancel: running tasks are killed (their runner gets the abort signal); queued and waiting
//   tasks fail; the run is cancelled. An Apply that already ran goes to needs_check; an approved
//   application whose Apply never started is marked failed.
// - Re-run a failed or finished step: it and the steps after it in its branch (or, for a
//   run-level step, everything after it) are reset and run again. Apply and record steps are
//   never re-run, and nothing is re-run once Apply started for a job it would touch.
import {
  getRun,
  getStep,
  listSteps,
  listTasks,
  resetStep,
  updateRunStatus,
  type Conn,
  type Step,
} from "../db/index.js";
import { moveApplication } from "./apply.js";
import { loadRunCtx, stepDef, type RunCtx } from "./context.js";
import type { EngineCore } from "./core.js";
import { forbidden, invalidState, notFound } from "./errors.js";
import type { ActionStepOutput } from "./state.js";
import { isTerminalStep, setStep, stepRef } from "./steps.js";
import { failTaskNow } from "./task-events.js";

const ACTIVE = ["running", "waiting", "paused"];

function emitRunUpdated(core: EngineCore, conn: Conn, runId: number, status: "running" | "waiting" | "paused"): void {
  core.bus.emit(conn, { type: "run.updated", runId: String(runId), status });
}

export function pauseRun(core: EngineCore, runId: number): void {
  core.db.transaction((tx) => {
    const run = getRun(tx, runId);
    if (!run) throw notFound("run", runId);
    if (run.status === "paused") return;
    if (!ACTIVE.includes(run.status)) throw invalidState(`run ${runId} is ${run.status}`);
    updateRunStatus(tx, runId, "paused", { now: core.now() });
    emitRunUpdated(core, tx, runId, "paused");
  });
  core.bus.flush();
}

export function resumeRun(core: EngineCore, runId: number): void {
  core.db.transaction((tx) => {
    const run = getRun(tx, runId);
    if (!run) throw notFound("run", runId);
    if (run.status !== "paused") throw invalidState(`run ${runId} is not paused`);
    updateRunStatus(tx, runId, "running", { now: core.now() });
    emitRunUpdated(core, tx, runId, "running");
  });
  core.advance(runId);
  core.dispatch();
}

/** Returns the ids of the tasks that were running and got the abort signal. */
export function cancelRun(core: EngineCore, runId: number): number[] {
  const running: number[] = [];
  core.db.transaction((tx) => {
    const run = getRun(tx, runId);
    if (!run) throw notFound("run", runId);
    if (!ACTIVE.includes(run.status)) throw invalidState(`run ${runId} is ${run.status}`);
    for (const task of listTasks(tx, { runId })) {
      if (task.status === "done" || task.status === "failed") continue;
      if (task.status === "running") {
        running.push(task.id);
        continue;
      }
      failTaskNow(core, tx, task, "run cancelled");
      if (task.botName === "apply" && task.kind === "submit") {
        const out = task.stepId === null ? null : (getStep(tx, task.stepId)?.output as ActionStepOutput | null);
        if (out?.applicationId) {
          // Paused or interrupted after it ran: it may have filled the form → needs_check. Never ran → failed.
          const ran = task.output !== null || task.status === "interrupted";
          moveApplication(core, tx, out.applicationId, ran ? "needs_check" : "failed", "run cancelled");
        }
      }
    }
    for (const step of listSteps(tx, runId)) {
      if (!isTerminalStep(step)) setStep(core, tx, step, "cancelled", { preview: "cancelled" });
    }
    updateRunStatus(tx, runId, "cancelled", { now: core.now() });
    core.bus.emit(tx, { type: "run.finished", runId: String(runId), status: "cancelled", summary: "Cancelled" });
  });
  core.bus.flush();
  // The runners see the abort; settle then records each (Apply → needs_check).
  for (const id of running) core.abortTask(id);
  return running;
}

/** Steps a re-run of `row` invalidates: later steps in its branch, or everything after a run-level step. */
function invalidated(ctx: RunCtx, rows: Step[], row: Step): Step[] {
  const order = ctx.def.steps.map((s) => s.key);
  const index = order.indexOf(row.stepKey);
  if (row.branchKey === "") {
    // Run level: later run-level steps and every per-job branch.
    return rows.filter((r) => r.id !== row.id && (r.branchKey !== "" || order.indexOf(r.stepKey) > index));
  }
  const jobId = row.branchKey.split(":")[0]!;
  return rows.filter(
    (r) => r.id !== row.id && (r.branchKey === jobId || r.branchKey.startsWith(`${jobId}:`)) && order.indexOf(r.stepKey) > index,
  );
}

export function rerunStep(core: EngineCore, stepId: number): void {
  const stillRunning: number[] = [];
  const runId = core.db.transaction((tx) => {
    const row = getStep(tx, stepId);
    if (!row) throw notFound("step", stepId);
    const ctx = loadRunCtx(core, row.runId, tx);
    if (!ctx) throw notFound("run", row.runId);
    if (ctx.run.status === "cancelled") throw invalidState(`run ${row.runId} was cancelled`);
    if (!isTerminalStep(row)) throw invalidState("only a failed or finished step can be re-run");
    const def = stepDef(ctx, row.stepKey);
    if (def?.type === "action" || def?.type === "record") {
      throw forbidden("Apply and record steps are never re-run (UC-23); approve again or use “apply again”");
    }
    const rows = listSteps(tx, row.runId);
    const later = invalidated(ctx, rows, row);
    const applyStarted = later.find((r) => stepDef(ctx, r.stepKey)?.type === "action" && !["locked", "pending", "skipped"].includes(r.status));
    if (applyStarted) throw forbidden(`Apply already started for job ${applyStarted.branchKey}; that branch cannot be re-run`);
    for (const r of [row, ...later]) {
      for (const task of listTasks(tx, { stepId: r.id })) {
        if (task.status === "running") stillRunning.push(task.id);
        if (task.status !== "done" && task.status !== "failed") failTaskNow(core, tx, task, "invalidated by a re-run (UC-23)");
      }
      const reset = resetStep(tx, r.id);
      core.bus.emit(tx, { type: "step.updated", ...stepRef(reset), status: "pending", round: reset.round, preview: "re-run", counts: null });
    }
    if (ctx.run.status === "done" || ctx.run.status === "failed") {
      updateRunStatus(tx, row.runId, "running", { now: core.now(), error: null });
      emitRunUpdated(core, tx, row.runId, "running");
    }
    return row.runId;
  });
  for (const id of stillRunning) core.abortTask(id);
  core.advance(runId);
  core.dispatch();
}
