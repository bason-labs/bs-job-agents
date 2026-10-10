import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Conn } from "../client.js";
import { events, type JsonObject } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { EventRow } from "../types.js";

export interface AppendEventInput {
  /** `run.*`, `step.*`, `task.progress`, `engine.paused`, `approval.*`, `safety.*`… (§10.2 rule 8, §11). */
  type: string;
  payload: JsonObject;
  runId?: number | null;
  taskId?: number | null;
}

export function appendEvent(db: Conn, input: AppendEventInput, opts?: ClockOpts): EventRow {
  return db
    .insert(events)
    .values({
      type: input.type,
      payload: input.payload,
      runId: input.runId ?? null,
      taskId: input.taskId ?? null,
      createdAt: nowIso(opts),
    })
    .returning()
    .get();
}

export interface ListEventsFilter {
  runId?: number;
  taskId?: number;
  /** For SSE replay: only events with id > afterId (`Last-Event-ID`). */
  afterId?: number;
  types?: readonly string[];
  limit?: number;
}

/** Oldest first. */
export function listEvents(db: Conn, filter: ListEventsFilter = {}): EventRow[] {
  const q = db
    .select()
    .from(events)
    .where(
      and(
        filter.runId !== undefined ? eq(events.runId, filter.runId) : undefined,
        filter.taskId !== undefined ? eq(events.taskId, filter.taskId) : undefined,
        filter.afterId !== undefined ? gt(events.id, filter.afterId) : undefined,
        filter.types ? inArray(events.type, [...filter.types]) : undefined,
      ),
    )
    .orderBy(asc(events.id));
  return filter.limit ? q.limit(filter.limit).all() : q.all();
}
