import { and, asc, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Conn } from "../client.js";
import { ACTIVE_RUN_STATUSES } from "../enums.js";
import { NotFoundError } from "../errors.js";
import { runs, schedules, type JsonObject } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { Schedule } from "../types.js";

/** UC-21: the Undo toast lasts 6 s; soft-deleted schedules are purged after it. */
export const UNDO_WINDOW_MS = 6000;

export interface CreateScheduleInput {
  name: string;
  /** 5-field cron (validated by the API). */
  cron: string;
  /** IANA zone the cron runs in; defaults to Asia/Ho_Chi_Minh (§11 Schedules, §15.2). */
  timezone?: string;
  workflowName: string;
  /** NULL = the active Search Profile. */
  searchProfileId?: number | null;
  /** Per-run overrides of profile fields. */
  params?: JsonObject;
  enabled?: boolean;
  nextRunAt?: string | null;
}

export function createSchedule(db: Conn, input: CreateScheduleInput, opts?: ClockOpts): Schedule {
  const now = nowIso(opts);
  return db
    .insert(schedules)
    .values({
      name: input.name,
      cron: input.cron,
      ...(input.timezone ? { timezone: input.timezone } : {}),
      workflowName: input.workflowName,
      searchProfileId: input.searchProfileId ?? null,
      params: input.params ?? {},
      enabled: input.enabled ?? true,
      nextRunAt: input.nextRunAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function getSchedule(db: Conn, id: number, opts: { includeDeleted?: boolean } = {}): Schedule | undefined {
  return db
    .select()
    .from(schedules)
    .where(and(eq(schedules.id, id), opts.includeDeleted ? undefined : isNull(schedules.deletedAt)))
    .get();
}

export function listSchedules(db: Conn, opts: { includeDeleted?: boolean } = {}): Schedule[] {
  return db
    .select()
    .from(schedules)
    .where(opts.includeDeleted ? undefined : isNull(schedules.deletedAt))
    .orderBy(asc(schedules.id))
    .all();
}

export type SchedulePatch = Partial<
  Pick<Schedule, "name" | "cron" | "timezone" | "workflowName" | "searchProfileId" | "params" | "enabled" | "nextRunAt">
>;

/** Edit a live (not deleted) schedule. */
export function updateSchedule(db: Conn, id: number, patch: SchedulePatch, opts?: ClockOpts): Schedule {
  const row = db
    .update(schedules)
    .set({ ...patch, updatedAt: nowIso(opts) })
    .where(and(eq(schedules.id, id), isNull(schedules.deletedAt)))
    .returning()
    .get();
  if (!row) throw new NotFoundError("schedule", id);
  return row;
}

export function setScheduleEnabled(db: Conn, id: number, enabled: boolean, opts?: ClockOpts): Schedule {
  return updateSchedule(db, id, { enabled }, opts);
}

/**
 * UC-21 delete: stops future scans; past runs, review cards and applications are
 * kept, and an active run is not cancelled.
 */
export function softDeleteSchedule(db: Conn, id: number, opts?: ClockOpts): Schedule {
  const row = db
    .update(schedules)
    .set({ deletedAt: nowIso(opts), updatedAt: nowIso(opts) })
    .where(and(eq(schedules.id, id), isNull(schedules.deletedAt)))
    .returning()
    .get();
  if (!row) throw new NotFoundError("schedule", id);
  return row;
}

/** Undo a soft delete (until it is purged). */
export function restoreSchedule(db: Conn, id: number, opts?: ClockOpts): Schedule {
  const row = db
    .update(schedules)
    .set({ deletedAt: null, updatedAt: nowIso(opts) })
    .where(and(eq(schedules.id, id), isNotNull(schedules.deletedAt)))
    .returning()
    .get();
  if (!row) throw new NotFoundError("deleted schedule", id);
  return row;
}

/** Hard-delete schedules soft-deleted at least `olderThanMs` ago. Runs keep their rows (schedule_id → NULL). */
export function purgeDeletedSchedules(db: Conn, opts: ClockOpts & { olderThanMs?: number } = {}): number {
  const now = (opts.now ?? new Date()).getTime();
  const cutoff = new Date(now - (opts.olderThanMs ?? UNDO_WINDOW_MS)).toISOString();
  return db
    .delete(schedules)
    .where(and(isNotNull(schedules.deletedAt), lte(schedules.deletedAt, cutoff)))
    .run().changes;
}

/** After the scheduler starts a run: remember it and the next fire time. */
export function recordScheduleFired(
  db: Conn,
  id: number,
  input: { runId: number; nextRunAt: string | null },
  opts?: ClockOpts,
): Schedule {
  const row = db
    .update(schedules)
    .set({ lastRunId: input.runId, nextRunAt: input.nextRunAt, updatedAt: nowIso(opts) })
    .where(eq(schedules.id, id))
    .returning()
    .get();
  if (!row) throw new NotFoundError("schedule", id);
  return row;
}

/** §7.4 no overlap / UC-02a: is a run of this schedule still active? */
export function hasActiveRun(db: Conn, scheduleId: number): boolean {
  const schedule = getSchedule(db, scheduleId, { includeDeleted: true });
  const row = db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
        or(eq(runs.scheduleId, scheduleId), schedule?.lastRunId ? eq(runs.id, schedule.lastRunId) : undefined),
      ),
    )
    .limit(1)
    .get();
  return row !== undefined;
}

/** Enabled, not deleted schedules whose `next_run_at` has been reached. */
export function dueSchedules(db: Conn, opts?: ClockOpts): Schedule[] {
  return db
    .select()
    .from(schedules)
    .where(
      and(
        isNull(schedules.deletedAt),
        eq(schedules.enabled, true),
        isNotNull(schedules.nextRunAt),
        lte(schedules.nextRunAt, nowIso(opts)),
      ),
    )
    .orderBy(asc(schedules.nextRunAt))
    .all();
}
