import { LIMITS, NON_RETRYABLE_TASKS, canTransitionApplicationStatus } from "@bs-job-agents/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Conn } from "../client.js";
import { tasks } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { Task } from "../types.js";
import { getApplication, transitionApplication } from "./applications.js";
import { appendAppEvent } from "./events.js";

export interface RecoveryOptions extends ClockOpts {
  /** Attempt cap per task (§5.5 step 6: initial + 1 retry). */
  maxAttempts?: number;
  /** Tasks never re-queued after a crash (default: the shared NON_RETRYABLE_TASKS, UC-18 exception). */
  nonRetryable?: readonly { botName: string; kind: string }[];
}

export interface RecoveryResult {
  /** Re-queued as a new attempt. */
  requeued: Task[];
  /** Out of attempts → failed (Lead reports it). */
  exhausted: Task[];
  /**
   * Left `interrupted` and not re-queued: an apply.submit that may already have
   * been submitted. Its application went to `needs_check` in the same transaction.
   */
  needsCheck: Task[];
  /**
   * Applications moved to `needs_check` (PM S2): those of this start-up's interrupted Apply
   * tasks, plus any an older build left approved or paused behind an interrupted Apply task.
   */
  needsCheckApplicationIds: number[];
}

/** PM S2: from the shared constants, so a renamed kind cannot silently re-queue an Apply. */
export const DEFAULT_NON_RETRYABLE = NON_RETRYABLE_TASKS;

export const INTERRUPTED_APPLY_NOTE = "interrupted by restart; it may already have been submitted";

/** The application an Apply task works for: its input's `applicationId` (decimal string or number). */
export function applicationIdOfTask(task: Pick<Task, "input">): number | null {
  const raw = (task.input as { applicationId?: unknown } | null)?.applicationId;
  const id = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** UC-18 exception: the application of an interrupted Apply goes to needs_check, if it is still in the apply flow. */
function markApplicationNeedsCheck(tx: Conn, task: Task, opts: ClockOpts): number | null {
  const applicationId = applicationIdOfTask(task);
  if (applicationId === null) return null;
  const app = getApplication(tx, applicationId);
  if (!app || !canTransitionApplicationStatus(app.status, "needs_check", "system", { dryRun: app.dryRun })) return null;
  const updated = transitionApplication(tx, app.id, "needs_check", { ...opts, note: INTERRUPTED_APPLY_NOTE });
  appendAppEvent(
    tx,
    {
      type: "application.updated",
      applicationId: String(updated.id),
      jobId: String(updated.jobId),
      status: updated.status,
      origin: updated.origin,
    },
    opts,
  );
  return updated.id;
}

/**
 * UC-18, run once on orchestrator start before the engine claims anything:
 * tasks left `running` are marked `interrupted`, then re-queued as a new attempt
 * (or failed when out of attempts). An interrupted apply.submit is never
 * re-queued: it stays `interrupted` and its application goes to `needs_check` in the same
 * transaction (PM S2); Apply tasks an older build left interrupted are reconciled the same
 * way. Writes a shared `task.finished` (interrupted) event per task. Runs continue from
 * their last finished step because step outputs were persisted.
 */
export function recoverInterruptedTasks(db: Conn, opts: RecoveryOptions = {}): RecoveryResult {
  const maxAttempts = opts.maxAttempts ?? LIMITS.maxAttempts;
  const nonRetryable = opts.nonRetryable ?? DEFAULT_NON_RETRYABLE;
  const isNonRetryable = (t: Task) => nonRetryable.some((n) => n.botName === t.botName && n.kind === t.kind);
  const now = nowIso(opts);
  return db.transaction(
    (tx) => {
      const result: RecoveryResult = { requeued: [], exhausted: [], needsCheck: [], needsCheckApplicationIds: [] };
      const markNeedsCheck = (task: Task) => {
        const id = markApplicationNeedsCheck(tx, task, opts);
        if (id !== null && !result.needsCheckApplicationIds.includes(id)) result.needsCheckApplicationIds.push(id);
      };
      // An older build may have left Apply tasks interrupted with their application still approved.
      const leftover = tx
        .select()
        .from(tasks)
        .where(eq(tasks.status, "interrupted"))
        .all()
        .filter(isNonRetryable)
        .sort((a, b) => a.id - b.id);
      for (const task of leftover) markNeedsCheck(task);

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
        if (isNonRetryable(task)) {
          result.needsCheck.push(task);
          markNeedsCheck(task);
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
