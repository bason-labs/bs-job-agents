import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Conn } from "../client.js";
import {
  ACTIVE_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  TERMINAL_STEP_STATUSES,
  type RunStatus,
  type RunTrigger,
  type StepStatus,
} from "../enums.js";
import { NotFoundError } from "../errors.js";
import { runs, steps, type JsonObject } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { Run, Step } from "../types.js";

// ---------------------------------------------------------------- runs

export interface CreateRunInput {
  workflowName: string;
  workflowVersion: number;
  trigger: RunTrigger;
  params: JsonObject;
  /** The Search Profile version the run starts with; it keeps it after later edits (UC-21b). */
  searchProfileVersion?: number | null;
  /** The id of that version's row (`search_profiles.id`), so the run can read it later. */
  searchProfileId?: number | null;
  scheduleId?: number | null;
  status?: RunStatus;
  /** PM3 S4: the saved preset Lead started the run from (its workflow is the preset's base). */
  presetName?: string | null;
}

export function createRun(db: Conn, input: CreateRunInput, opts?: ClockOpts): Run {
  return db
    .insert(runs)
    .values({
      workflowName: input.workflowName,
      workflowVersion: input.workflowVersion,
      trigger: input.trigger,
      params: input.params,
      searchProfileVersion: input.searchProfileVersion ?? null,
      searchProfileId: input.searchProfileId ?? null,
      scheduleId: input.scheduleId ?? null,
      presetName: input.presetName ?? null,
      status: input.status ?? "running",
      createdAt: nowIso(opts),
    })
    .returning()
    .get();
}

export function getRun(db: Conn, id: number): Run | undefined {
  return db.select().from(runs).where(eq(runs.id, id)).get();
}

export interface ListRunsFilter {
  status?: RunStatus | readonly RunStatus[];
  limit?: number;
}

/** Newest first. */
export function listRuns(db: Conn, filter: ListRunsFilter = {}): Run[] {
  const statuses = filter.status === undefined ? undefined : ([] as RunStatus[]).concat(filter.status);
  const q = db
    .select()
    .from(runs)
    .where(statuses ? inArray(runs.status, statuses) : undefined)
    .orderBy(desc(runs.createdAt), desc(runs.id));
  return filter.limit ? q.limit(filter.limit).all() : q.all();
}

/** Runs that are `running`, `waiting` or `paused`. */
export function listActiveRuns(db: Conn): Run[] {
  return listRuns(db, { status: ACTIVE_RUN_STATUSES });
}

export function updateRunStatus(
  db: Conn,
  id: number,
  status: RunStatus,
  opts: ClockOpts & { error?: string | null } = {},
): Run {
  const terminal = (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
  const row = db
    .update(runs)
    .set({
      status,
      finishedAt: terminal ? nowIso(opts) : null,
      ...(opts.error !== undefined ? { error: opts.error } : {}),
    })
    .where(eq(runs.id, id))
    .returning()
    .get();
  if (!row) throw new NotFoundError("run", id);
  return row;
}

// ---------------------------------------------------------------- steps

export interface CreateStepInput {
  runId: number;
  stepKey: string;
  /** Job id for per-job branches; omit for run-level steps. */
  branchKey?: string;
  status?: StepStatus;
  /** Gate round (1..maxRounds) for gate steps. */
  round?: number | null;
}

export function createStep(db: Conn, input: CreateStepInput): Step {
  return db
    .insert(steps)
    .values({
      runId: input.runId,
      stepKey: input.stepKey,
      branchKey: input.branchKey ?? "",
      status: input.status ?? "pending",
      round: input.round ?? null,
    })
    .returning()
    .get();
}

export function getStep(db: Conn, id: number): Step | undefined {
  return db.select().from(steps).where(eq(steps.id, id)).get();
}

export function getStepByKey(db: Conn, runId: number, stepKey: string, branchKey = ""): Step | undefined {
  return db
    .select()
    .from(steps)
    .where(and(eq(steps.runId, runId), eq(steps.stepKey, stepKey), eq(steps.branchKey, branchKey)))
    .get();
}

/** In creation order. */
export function listSteps(db: Conn, runId: number): Step[] {
  return db.select().from(steps).where(eq(steps.runId, runId)).orderBy(asc(steps.id)).all();
}

/**
 * Persist a step's status (and output). Spec UC-18: a finished step's output is
 * written before the next step starts, so the engine calls this with `output`
 * when the step is done.
 */
export function updateStepStatus(
  db: Conn,
  id: number,
  status: StepStatus,
  opts: ClockOpts & { output?: unknown; error?: string | null; round?: number | null } = {},
): Step {
  const current = getStep(db, id);
  if (!current) throw new NotFoundError("step", id);
  const now = nowIso(opts);
  const terminal = (TERMINAL_STEP_STATUSES as readonly string[]).includes(status);
  return db
    .update(steps)
    .set({
      status,
      startedAt: status === "running" && !current.startedAt ? now : current.startedAt,
      finishedAt: terminal ? now : null,
      ...(opts.output !== undefined ? { output: opts.output } : {}),
      ...(opts.error !== undefined ? { error: opts.error } : {}),
      ...(opts.round !== undefined ? { round: opts.round } : {}),
    })
    .where(eq(steps.id, id))
    .returning()
    .get()!;
}

/** Back to `pending` with output cleared, for re-running a step (UC-23). */
export function resetStep(db: Conn, id: number): Step {
  const row = db
    .update(steps)
    .set({ status: "pending", output: null, error: null, startedAt: null, finishedAt: null })
    .where(eq(steps.id, id))
    .returning()
    .get();
  if (!row) throw new NotFoundError("step", id);
  return row;
}
