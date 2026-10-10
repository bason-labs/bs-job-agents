// Step rows and their events. Every status change of a step is persisted (with its output)
// before the engine moves on (UC-18), and appended as a shared step.* event (§11).
import type { StepStatus } from "@bs-job-agents/shared";
import { TERMINAL_STEP_STATUSES, createStep, getStepByKey, updateStepStatus, type Conn, type Step } from "../db/index.js";
import type { RunCtx, Scope } from "./context.js";
import type { EngineCore } from "./core.js";
import type { MapCounts } from "./state.js";

export const isTerminalStep = (row: Pick<Step, "status">): boolean => (TERMINAL_STEP_STATUSES as readonly string[]).includes(row.status);

export function stepRef(row: Step) {
  return { runId: String(row.runId), stepId: String(row.id), stepKey: row.stepKey, branchKey: row.branchKey === "" ? null : row.branchKey };
}

export interface StepChange {
  output?: unknown;
  error?: string | null;
  round?: number | null;
  preview?: string | null;
  counts?: MapCounts | null;
}

/** Set a step's status (persisting output first) and append the matching step.* event. */
export function setStep(core: EngineCore, conn: Conn, row: Step, status: StepStatus, change: StepChange = {}): Step {
  const before = row.status;
  const updated = updateStepStatus(conn, row.id, status, {
    now: core.now(),
    ...(change.output !== undefined ? { output: change.output } : {}),
    ...(change.error !== undefined ? { error: change.error } : {}),
    ...(change.round !== undefined ? { round: change.round } : {}),
  });
  const ref = stepRef(updated);
  const idle = (s: StepStatus) => s === "pending" || s === "locked";
  if (idle(before) && !idle(status)) core.bus.emit(conn, { type: "step.started", ...ref, round: updated.round });
  if (isTerminalStep(updated)) {
    core.bus.emit(conn, {
      type: "step.finished",
      ...ref,
      status: updated.status as "done" | "failed" | "skipped" | "cancelled",
      preview: change.preview ?? null,
      error: updated.error,
    });
  } else {
    core.bus.emit(conn, {
      type: "step.updated",
      ...ref,
      status: updated.status,
      round: updated.round,
      preview: change.preview ?? null,
      counts: change.counts ?? null,
    });
  }
  return updated;
}

/** The step row in this scope, created `pending` when missing, then moved to `status`. */
export function openStep(core: EngineCore, conn: Conn, ctx: RunCtx, key: string, scope: Scope, status: StepStatus, change: StepChange = {}): Step {
  const row =
    getStepByKey(conn, ctx.run.id, key, scope.branchKey) ??
    createStep(conn, { runId: ctx.run.id, stepKey: key, branchKey: scope.branchKey, status: "pending" });
  return setStep(core, conn, row, status, change);
}
