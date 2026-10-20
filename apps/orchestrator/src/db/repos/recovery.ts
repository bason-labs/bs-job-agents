import { LIMITS, NON_RETRYABLE_TASKS, canTransitionApplicationStatus } from "@bs-job-agents/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Conn } from "../client.js";
import { tasks } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { Task } from "../types.js";
import { getApplication, transitionApplication } from "./applications.js";
import { appendAppEvent, listEvents } from "./events.js";

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
  /**
   * Left `interrupted` and not re-queued: an Apply task whose recorded tool calls show it never
   * opened a page of the job site (live 2026-10-20: Chrome never answered). Its application went
   * to `failed` ("nothing was submitted"), so Applications offers Apply again.
   */
  notSubmitted: Task[];
  notSubmittedApplicationIds: number[];
}

/** PM S2: from the shared constants, so a renamed kind cannot silently re-queue an Apply. */
export const DEFAULT_NON_RETRYABLE = NON_RETRYABLE_TASKS;

export const INTERRUPTED_APPLY_NOTE = "interrupted by restart; it may already have been submitted";
export const INTERRUPTED_BEFORE_PAGE_NOTE = "interrupted by a restart before any page of the job site was opened";

/**
 * Chrome tools that never open or touch a page of the job site: listing, creating (empty), closing
 * and choosing tabs or browsers. Any other Chrome tool (navigate, form_input, computer, find,
 * read_page, a tool added later, …) counts as touching a page. Tools outside Chrome cannot submit.
 */
const NO_PAGE_CHROME_TOOLS = new Set(["tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp", "list_connected_browsers", "select_browser", "switch_browser"]);

/**
 * Did this Apply attempt possibly open a page of the job site? Decided from its recorded tool calls
 * (task.progress tool_use events), like skill repair attributes its tab navigations. Without a
 * record that the attempt started (task.started), or on an engine other than Claude, nothing proves
 * it did not: yes.
 */
export function mayHaveOpenedPage(tx: Conn, task: Task): boolean {
  // Only Claude's runner reports Claude in Chrome tool calls by name; on any other engine nothing
  // proves no page was opened.
  if (task.engine !== "claude") return true;
  const rows = listEvents(tx, { taskId: task.id, types: ["task.started", "task.progress"] });
  const attempt = rows.filter((r) => (r.payload as { attempt?: unknown }).attempt === task.attempt && r.type === "task.started");
  if (attempt.length === 0) return true;
  const since = attempt.at(-1)!.id;
  return rows.some((r) => {
    if (r.id < since || r.type !== "task.progress") return false;
    const p = r.payload as { kind?: unknown; tool?: unknown };
    if (p.kind !== "tool_use" || typeof p.tool !== "string") return false;
    const m = /claude-in-chrome__(.+)$/.exec(p.tool);
    return m !== null && !NO_PAGE_CHROME_TOOLS.has(m[1]!);
  });
}

/** An interrupted Apply that never opened a page: its application failed, nothing was submitted (Apply again). */
function markApplicationNotSubmitted(tx: Conn, task: Task, opts: ClockOpts): number | null {
  const applicationId = applicationIdOfTask(task);
  if (applicationId === null) return null;
  const app = getApplication(tx, applicationId);
  if (!app || !canTransitionApplicationStatus(app.status, "failed", "system", { dryRun: app.dryRun })) return null;
  const updated = transitionApplication(tx, app.id, "failed", { ...opts, note: INTERRUPTED_BEFORE_PAGE_NOTE });
  appendAppEvent(tx, { type: "application.updated", applicationId: String(updated.id), jobId: String(updated.jobId), status: updated.status, origin: updated.origin }, opts);
  return updated.id;
}

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
      const result: RecoveryResult = { requeued: [], exhausted: [], needsCheck: [], needsCheckApplicationIds: [], notSubmitted: [], notSubmittedApplicationIds: [] };
      const markNeedsCheck = (task: Task) => {
        const id = markApplicationNeedsCheck(tx, task, opts);
        if (id !== null && !result.needsCheckApplicationIds.includes(id)) result.needsCheckApplicationIds.push(id);
      };
      /** needs_check when a job-site page may have been opened; else plainly not submitted. Which list the task joins. */
      const settleApply = (task: Task): "needsCheck" | "notSubmitted" => {
        if (mayHaveOpenedPage(tx, task)) {
          markNeedsCheck(task);
          return "needsCheck";
        }
        const id = markApplicationNotSubmitted(tx, task, opts);
        if (id !== null && !result.notSubmittedApplicationIds.includes(id)) result.notSubmittedApplicationIds.push(id);
        return "notSubmitted";
      };
      // An older build may have left Apply tasks interrupted with their application still approved.
      const leftover = tx
        .select()
        .from(tasks)
        .where(eq(tasks.status, "interrupted"))
        .all()
        .filter(isNonRetryable)
        .sort((a, b) => a.id - b.id);
      for (const task of leftover) settleApply(task);

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
          result[settleApply(task)].push(task);
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
