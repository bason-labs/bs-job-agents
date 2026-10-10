// What every route works with: the settings, whether the engine runs (S19 degraded start), the
// database, the engine, and the event hub SSE reads from. Reads use the db repositories and
// mappers directly; every write that changes run state goes through the engine (W2a brief).
import type { AppEvent, DegradedReason } from "@bs-job-agents/shared";
import { max } from "drizzle-orm";
import { appendAppEvent, listEvents, mappers, schema, type AppEventInput, type Db } from "../db/index.js";
import { EventBus } from "../engine/events.js";
import type { BotRegistry, Engine, Logger, WorkflowSource } from "../engine/index.js";
import { ApiHttpError } from "./errors.js";

export interface ApiConfig {
  /** Absolute data/ folder (files are served from inside it only). */
  dataDir: string;
  botsDir: string;
  workflowsDir: string;
  port: number;
  webOrigins: readonly string[];
}

export interface Recovered {
  requeued: number;
  exhausted: number;
  needsCheck: number;
}

export type OrchestratorState =
  | { state: "running"; startedAt: string; recovered: Recovered | null }
  | { state: "degraded"; reason: DegradedReason; detail: string; startedAt: string };

/** Committed shared events, live (subscribe) and stored (replay), for SSE. */
export interface EventHub {
  subscribe(listener: (event: AppEvent) => void): () => void;
  /** Deliver what was committed since the last flush (after the API's own event writes). */
  flush(): void;
  /** Shared events with an id greater than `afterId`, in order (audit-only rows left out). */
  replay(afterId: number): AppEvent[];
  /** The newest event id, or 0. */
  lastId(): number;
}

export interface ApiContext {
  config: ApiConfig;
  state: OrchestratorState;
  /** Null when data/app.db could not be opened (degraded). */
  db: Db | null;
  /** Null when the engine could not be built; present but stopped when its start failed. */
  engine: Engine | null;
  bots: BotRegistry | null;
  workflows: WorkflowSource | null;
  events: EventHub | null;
  now(): Date;
  log: Logger;
}

function lastEventId(db: Db): number {
  return db.select({ id: max(schema.events.id) }).from(schema.events).get()?.id ?? 0;
}

/** The engine's own bus: what the engine and the API append reaches SSE in id order. */
export function engineEventHub(engine: Engine): EventHub {
  return {
    subscribe: (listener) => engine.subscribe((event) => listener(event)),
    flush: () => engine.bus.flush(),
    replay: (afterId) => engine.replay(afterId).map((r) => r.event),
    lastId: () => lastEventId(engine.db),
  };
}

/** Degraded mode without an engine: SSE still replays and streams what the API itself appends. */
export function dbEventHub(db: Db, now: () => Date): EventHub {
  const bus = new EventBus(db, now);
  return {
    subscribe: (listener) => bus.subscribe((event) => listener(event)),
    flush: () => bus.flush(),
    replay: (afterId) =>
      listEvents(db, { afterId })
        .map((row) => mappers.toAppEvent(row))
        .filter((e): e is AppEvent => e !== null),
    lastId: () => lastEventId(db),
  };
}

function degraded(ctx: ApiContext, what: string): ApiHttpError {
  const s = ctx.state;
  const why = s.state === "degraded" ? s.detail : `${what} is not available`;
  return new ApiHttpError(503, "internal", `the orchestrator runs in degraded mode: ${why}`, {
    reason: "degraded",
    cause: s.state === "degraded" ? s.reason : null,
  });
}

/** The database, or 503 when it could not be opened (S19). */
export function requireDb(ctx: ApiContext): Db {
  if (ctx.db) return ctx.db;
  throw degraded(ctx, "the database");
}

/** The running engine, or 503 in degraded mode: its commands would never run (S19). */
export function requireEngine(ctx: ApiContext): Engine {
  if (ctx.engine && ctx.state.state === "running") return ctx.engine;
  throw degraded(ctx, "the engine");
}

/** The API's own events (bot, application, export changes): append, then deliver (W2a brief). */
export function emitEvent(ctx: ApiContext, event: AppEventInput): void {
  appendAppEvent(requireDb(ctx), event, { now: ctx.now() });
  ctx.events?.flush();
}
