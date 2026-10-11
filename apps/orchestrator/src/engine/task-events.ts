// Task lifecycle writes paired with their shared events (§10.2 rule 8, §11).
import type { PauseReason, SafetyDenialReason } from "@bs-job-agents/shared";
import { failTask, getTask, requeueTask, type Conn, type Task } from "../db/index.js";
import type { EngineCore } from "./core.js";
import { postNotice } from "./notices.js";

export function emitTaskFinished(core: EngineCore, conn: Conn, task: Task, status: "done" | "failed" | "interrupted", error: string | null): void {
  core.bus.emit(conn, {
    type: "task.finished",
    taskId: String(task.id),
    runId: task.runId === null ? null : String(task.runId),
    stepId: task.stepId === null ? null : String(task.stepId),
    botName: task.botName,
    status,
    attempt: task.attempt,
    error,
  });
}

export function emitTaskPaused(core: EngineCore, conn: Conn, task: Task, reason: PauseReason): void {
  core.bus.emit(conn, {
    type: "task.paused",
    taskId: String(task.id),
    runId: task.runId === null ? null : String(task.runId),
    botName: task.botName,
    reason,
  });
}

/** Fail a task now (no retry) with its task.finished event. */
export function failTaskNow(core: EngineCore, conn: Conn, task: Task, error: string, output?: unknown): Task {
  const failed = failTask(conn, task.id, { error, now: core.now(), ...(output !== undefined ? { output } : {}) });
  emitTaskFinished(core, conn, failed, "failed", error);
  return failed;
}

/** Back to the queue after Ba acted or a bridge reconnected (same attempt), with task.resumed. */
export function resumeTaskNow(core: EngineCore, conn: Conn, task: Task): Task {
  const queued = requeueTask(conn, task.id);
  core.bus.emit(conn, { type: "task.resumed", taskId: String(task.id), runId: task.runId === null ? null : String(task.runId), botName: task.botName });
  return queued;
}

export function emitSafetyDenied(
  core: EngineCore,
  conn: Conn,
  input: { botName: string; taskId: number | null; action: string; reason: SafetyDenialReason; detail: string | null },
): void {
  core.bus.emit(conn, {
    type: "safety.denied",
    botName: input.botName,
    taskId: input.taskId === null ? null : String(input.taskId),
    action: input.action,
    reason: input.reason,
    detail: input.detail,
  });
}

export const stillRunning = (conn: Conn, taskId: number): boolean => getTask(conn, taskId)?.status === "running";

/** A message from Lead in the Lead chat (alerts Ba must act on), with its message.created event. */
export function postLeadMessage(core: EngineCore, conn: Conn, text: string, opts: { runId?: number | null } = {}): void {
  postNotice(core, conn, { text, runId: opts.runId ?? null });
}
