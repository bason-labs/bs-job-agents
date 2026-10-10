// The engine's event sink (§10.2 rule 8 audit log, §11 live updates). Events are shared
// AppEvents appended to the `events` table inside the transaction that caused them, so they
// commit or roll back with it. Subscribers (W3a's SSE) are told after commit: `flush()` tails the
// table by id, which also delivers events the repositories append themselves (crash recovery's
// task.finished, markSubmissionRefused's safety.denied).
import type { AppEvent } from "@bs-job-agents/shared";
import { appendAppEvent, appendEvent, listEvents, mappers, type AppEventInput, type Conn, type EventRow, type JsonObject } from "../db/index.js";

export type EventListener = (event: AppEvent, row: EventRow) => void;

export class EventBus {
  private lastId: number;
  private readonly listeners = new Set<EventListener>();

  constructor(
    private readonly db: Conn,
    private readonly now: () => Date,
  ) {
    this.lastId = listEvents(db).at(-1)?.id ?? 0;
  }

  /** Append a shared event (validated with AppEventSchema) on `conn`, e.g. inside a transaction. */
  emit(conn: Conn, event: AppEventInput): EventRow {
    return appendAppEvent(conn, event, { now: this.now() });
  }

  /** Append an audit-only row the UI does not stream (e.g. a spawned CLI's pid). */
  audit(conn: Conn, type: string, payload: JsonObject, refs: { runId?: number | null; taskId?: number | null } = {}): EventRow {
    return appendEvent(conn, { type, payload, runId: refs.runId ?? null, taskId: refs.taskId ?? null }, { now: this.now() });
  }

  /** A stored row as the shared event it was appended as; null for audit-only rows. */
  toAppEvent(row: EventRow): AppEvent | null {
    return mappers.toAppEvent(row);
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Deliver committed events since the last flush, in id order. Audit-only rows are skipped. */
  flush(): void {
    const rows = listEvents(this.db, { afterId: this.lastId });
    for (const row of rows) {
      this.lastId = row.id;
      const event = mappers.toAppEvent(row);
      if (!event) continue;
      for (const listener of this.listeners) {
        try {
          listener(event, row);
        } catch {
          // A subscriber bug must never break the engine.
        }
      }
    }
  }
}
