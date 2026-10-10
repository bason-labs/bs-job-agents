import { AppEventSchema, type AppEvent } from "@bs-job-agents/shared";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Conn } from "../client.js";
import { events, type JsonObject } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { EventRow } from "../types.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A shared SSE event (§11 live updates) without the id and time its row assigns. */
export type AppEventInput = DistributiveOmit<AppEvent, "id" | "at">;

const numericId = (value: unknown): number | null =>
  typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;

/**
 * Append a shared SSE event, validated with `AppEventSchema`. The row id is the SSE
 * `id:` and `mappers.toAppEvent(row)` replays it unchanged (Last-Event-ID). Prefer this
 * over `appendEvent` for anything the UI shows; `appendEvent` stays for audit-only rows.
 */
export function appendAppEvent(db: Conn, event: AppEventInput, opts?: ClockOpts): EventRow {
  const createdAt = nowIso(opts);
  const { id: _id, at: _at, type, ...payload } = AppEventSchema.parse({ ...event, id: "0", at: createdAt });
  const ref = payload as { runId?: unknown; taskId?: unknown };
  return db
    .insert(events)
    .values({ type, payload, runId: numericId(ref.runId), taskId: numericId(ref.taskId), createdAt })
    .returning()
    .get();
}

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
