import { LIMITS } from "@bs-job-agents/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Conn } from "../client.js";
import { tasks } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { Task } from "../types.js";
import { appendAppEvent } from "./events.js";

export interface RecoveryOptions extends ClockOpts {
  /** Attempt cap per task (§5.5 step 6: initial + 1 retry). */
  maxAttempts?: number;
  /** Tasks never re-queued after a crash (default: apply.submit, UC-18 exception). */
  nonRetryable?: readonly { botName: string; kind: string }[];
}

export interface RecoveryResult {
  /** Re-queued as a new attempt. */
  requeued: Task[];
  /** Out of attempts → failed (Lead reports it). */
  exhausted: Task[];
  /**
   * Left `interrupted` and not re-queued: an apply.submit that may already have
   * been submitted. The engine marks its application `needs_check`.
   */
  needsCheck: Task[];
}

export const DEFAULT_NON_RETRYABLE = [{ botName: "apply", kind: "submit" }] as const;

/**
 * UC-18, run once on orchestrator start before the engine claims anything:
 * tasks left `running` are marked `interrupted`, then re-queued as a new attempt
 * (or failed when out of attempts). An interrupted apply.submit is never
 * re-queued. Writes a shared `task.finished` (interrupted) event per task. Runs continue from
 * their last finished step because step outputs were persisted.
 */
export function recoverInterruptedTasks(db: Conn, opts: RecoveryOptions = {}): RecoveryResult {
  const maxAttempts = opts.maxAttempts ?? LIMITS.maxAttempts;
  const nonRetryable = opts.nonRetryable ?? DEFAULT_NON_RETRYABLE;
  const now = nowIso(opts);
  return db.transaction(
    (tx) => {
      const result: RecoveryResult = { requeued: [], exhausted: [], needsCheck: [] };
      const interrupted = tx
        .update(tasks)
        .set({ status: "interrupted" })
        .where(eq(tasks.status, "running"))
        .returning()
        .all()
        .sort((a, b) => a.id - b.id);

      for (const task of interrupted) {
        // The shared SSE event, so the UI sees the interrupted attempt on replay.
        appendAppEvent(
          tx,
          {
            type: "task.finished",
            taskId: String(task.id),
            runId: task.runId === null ? null : String(task.runId),
            stepId: task.stepId === null ? null : String(task.stepId),
            botName: task.botName,
            status: "interrupted",
            attempt: task.attempt,
            error: "interrupted by restart",
          },
          opts,
        );
        if (nonRetryable.some((n) => n.botName === task.botName && n.kind === task.kind)) {
          result.needsCheck.push(task);
        } else if (task.attempt < maxAttempts) {
          result.requeued.push(
            tx
              .update(tasks)
              .set({ status: "queued", attempt: task.attempt + 1, startedAt: null, finishedAt: null })
              .where(and(eq(tasks.id, task.id), inArray(tasks.status, ["interrupted"])))
              .returning()
              .get()!,
          );
        } else {
          result.exhausted.push(
            tx
              .update(tasks)
              .set({ status: "failed", error: "interrupted by restart; no attempts left", finishedAt: now })
              .where(eq(tasks.id, task.id))
              .returning()
              .get()!,
          );
        }
      }
      return result;
    },
    { behavior: "immediate" },
  );
}
