import { PauseReasonSchema, formatPauseReason, type PauseReason } from "@bs-job-agents/shared";
import { and, asc, count, eq, gt, inArray, isNull, notExists, or, type SQL } from "drizzle-orm";
import type { Conn } from "../client.js";
import { TERMINAL_TASK_STATUSES, type Engine, type TaskStatus } from "../enums.js";
import { InvalidTransitionError, NotFoundError } from "../errors.js";
import { engineState, runs, tasks } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { Task } from "../types.js";

export interface CreateTaskInput {
  /** null for consult (UC-25) and discussion (UC-15) tasks, which run outside a workflow. */
  runId: number | null;
  stepId: number | null;
  botName: string;
  kind: string;
  engine: Engine;
  input: unknown;
  /** bot.json promptVersion the task runs with (stored for the lookback loop, §1.3 C). */
  promptVersion: number;
  /** Needs the browser lock (drives Ba's Chrome). */
  usesBrowser?: boolean;
  /** Needs the Figma lock. */
  usesFigma?: boolean;
  attempt?: number;
}

export function createTask(db: Conn, input: CreateTaskInput, opts?: ClockOpts): Task {
  return db
    .insert(tasks)
    .values({
      runId: input.runId,
      stepId: input.stepId,
      botName: input.botName,
      kind: input.kind,
      engine: input.engine,
      input: input.input,
      promptVersion: input.promptVersion,
      usesBrowser: input.usesBrowser ?? false,
      usesFigma: input.usesFigma ?? false,
      attempt: input.attempt ?? 1,
      status: "queued",
      createdAt: nowIso(opts),
    })
    .returning()
    .get();
}

export function getTask(db: Conn, id: number): Task | undefined {
  return db.select().from(tasks).where(eq(tasks.id, id)).get();
}

function mustGet(db: Conn, id: number): Task {
  const t = getTask(db, id);
  if (!t) throw new NotFoundError("task", id);
  return t;
}

export interface ListTasksFilter {
  runId?: number;
  stepId?: number;
  status?: TaskStatus | readonly TaskStatus[];
  engine?: Engine;
}

function whereTasks(filter: ListTasksFilter): SQL | undefined {
  const statuses = filter.status === undefined ? undefined : ([] as TaskStatus[]).concat(filter.status);
  return and(
    filter.runId !== undefined ? eq(tasks.runId, filter.runId) : undefined,
    filter.stepId !== undefined ? eq(tasks.stepId, filter.stepId) : undefined,
    statuses ? inArray(tasks.status, statuses) : undefined,
    filter.engine ? eq(tasks.engine, filter.engine) : undefined,
  );
}

/** Oldest first. */
export function listTasks(db: Conn, filter: ListTasksFilter = {}): Task[] {
  return db.select().from(tasks).where(whereTasks(filter)).orderBy(asc(tasks.createdAt), asc(tasks.id)).all();
}

/** E.g. running tasks per engine, for the concurrency limiter after a restart. */
export function countTasks(db: Conn, filter: ListTasksFilter = {}): number {
  return db.select({ n: count() }).from(tasks).where(whereTasks(filter)).get()?.n ?? 0;
}

export interface ClaimFilter extends ClockOpts {
  engines?: readonly Engine[];
  botNames?: readonly string[];
  kinds?: readonly string[];
  /** false while the browser lock is held: skip tasks with `usesBrowser`. */
  allowBrowser?: boolean;
  /** false while the Figma lock is held: skip tasks with `usesFigma`. */
  allowFigma?: boolean;
  /** Skip engines whose `engine_state.paused_until` is in the future (default true). */
  respectEnginePause?: boolean;
}

/**
 * Atomically claim the oldest runnable task and mark it `running`.
 *
 * Runnable = `queued`, its run is `running` or `waiting` (not paused/cancelled/
 * finished, UC-23) or it has no run (consult / discussion, §10.3 caps still apply),
 * it matches the filter, and its engine is not paused for a usage limit (UC-16).
 * Runs inside `BEGIN IMMEDIATE`, so two connections (or processes) never claim the
 * same task.
 */
export function claimNextTask(db: Conn, filter: ClaimFilter = {}): Task | undefined {
  const now = nowIso(filter);
  return db.transaction(
    (tx) => {
      const candidate = tx
        .select({ id: tasks.id })
        .from(tasks)
        .leftJoin(runs, eq(runs.id, tasks.runId))
        .where(
          and(
            eq(tasks.status, "queued"),
            or(isNull(tasks.runId), inArray(runs.status, ["running", "waiting"])),
            filter.engines ? inArray(tasks.engine, [...filter.engines]) : undefined,
            filter.botNames ? inArray(tasks.botName, [...filter.botNames]) : undefined,
            filter.kinds ? inArray(tasks.kind, [...filter.kinds]) : undefined,
            filter.allowBrowser === false ? eq(tasks.usesBrowser, false) : undefined,
            filter.allowFigma === false ? eq(tasks.usesFigma, false) : undefined,
            filter.respectEnginePause === false
              ? undefined
              : notExists(
                  tx
                    .select({ one: engineState.engine })
                    .from(engineState)
                    .where(and(eq(engineState.engine, tasks.engine), gt(engineState.pausedUntil, now))),
                ),
          ),
        )
        .orderBy(asc(tasks.createdAt), asc(tasks.id))
        .limit(1)
        .get();
      if (!candidate) return undefined;
      return tx
        .update(tasks)
        .set({ status: "running", startedAt: now, finishedAt: null, pauseReason: null })
        .where(and(eq(tasks.id, candidate.id), eq(tasks.status, "queued")))
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
}

function transition(
  db: Conn,
  id: number,
  from: readonly TaskStatus[],
  to: TaskStatus,
  set: Partial<typeof tasks.$inferInsert>,
): Task {
  const row = db
    .update(tasks)
    .set({ status: to, ...set })
    .where(and(eq(tasks.id, id), inArray(tasks.status, [...from])))
    .returning()
    .get();
  if (row) return row;
  const current = mustGet(db, id);
  throw new InvalidTransitionError("task", current.status, to);
}

export function completeTask(db: Conn, id: number, opts: ClockOpts & { output: unknown }): Task {
  return transition(db, id, ["running"], "done", { output: opts.output, finishedAt: nowIso(opts), error: null });
}

export function failTask(
  db: Conn,
  id: number,
  opts: ClockOpts & { error: string; output?: unknown },
): Task {
  return transition(db, id, ["running", "queued", "paused", "waiting_limit", "interrupted"], "failed", {
    error: opts.error,
    finishedAt: nowIso(opts),
    ...(opts.output !== undefined ? { output: opts.output } : {}),
  });
}

/**
 * Pause with a shared `PauseReason` (needs_browser, needs_figma, needs_login(site),
 * captcha(site), usage_limit, needs_answer, domain_confirm(site); UC-11/12/16/17).
 * Stored in the column form `code(site)` (formatPauseReason); invalid reasons throw.
 */
export function pauseTask(db: Conn, id: number, reason: PauseReason): Task {
  const valid = PauseReasonSchema.parse(reason);
  return transition(db, id, ["running", "queued"], "paused", { pauseReason: formatPauseReason(valid) });
}

/**
 * Put a task back in the queue. `newAttempt` bumps `attempt` (crash, timeout,
 * failed self-check); resuming after a pause keeps the attempt.
 */
export function requeueTask(db: Conn, id: number, opts: { newAttempt?: boolean } = {}): Task {
  const current = mustGet(db, id);
  if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(current.status)) {
    throw new InvalidTransitionError("task", current.status, "queued");
  }
  return transition(db, id, ["running", "paused", "waiting_limit", "interrupted", "queued"], "queued", {
    pauseReason: null,
    startedAt: null,
    finishedAt: null,
    attempt: opts.newAttempt ? current.attempt + 1 : current.attempt,
  });
}

export function setTaskTranscriptPath(db: Conn, id: number, path: string): Task {
  const row = db.update(tasks).set({ transcriptPath: path }).where(eq(tasks.id, id)).returning().get();
  if (!row) throw new NotFoundError("task", id);
  return row;
}

/** UC-16 step 3: queued tasks on a limited engine move to `waiting_limit`. Returns the count. */
export function holdEngineTasks(db: Conn, engine: Engine): number {
  return db
    .update(tasks)
    .set({ status: "waiting_limit" })
    .where(and(eq(tasks.engine, engine), eq(tasks.status, "queued")))
    .run().changes;
}

/** UC-16 step 5: at reset, `waiting_limit` tasks go back to the queue. Returns the count. */
export function releaseEngineTasks(db: Conn, engine: Engine): number {
  return db
    .update(tasks)
    .set({ status: "queued" })
    .where(and(eq(tasks.engine, engine), eq(tasks.status, "waiting_limit")))
    .run().changes;
}
