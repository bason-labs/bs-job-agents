import { and, isNotNull, lte } from "drizzle-orm";
import type { Conn } from "../client.js";
import { ENGINES, type Engine, type EnginePauseReason } from "../enums.js";
import { engineState } from "../schema.js";
import { nowIso, toIso, type ClockOpts } from "../time.js";

export interface EngineState {
  engine: Engine;
  pausedUntil: string | null;
  reason: EnginePauseReason | null;
}

/**
 * Pause an engine until `until` (UC-16). Callers that cannot parse a reset time
 * pass `now + 30 min` and pause again when it is still limited.
 */
export function pauseEngine(
  db: Conn,
  engine: Engine,
  opts: { until: Date | string; reason: EnginePauseReason },
): EngineState {
  const pausedUntil = toIso(opts.until);
  return db
    .insert(engineState)
    .values({ engine, pausedUntil, reason: opts.reason })
    .onConflictDoUpdate({ target: engineState.engine, set: { pausedUntil, reason: opts.reason } })
    .returning()
    .get();
}

export function resumeEngine(db: Conn, engine: Engine): EngineState {
  return db
    .insert(engineState)
    .values({ engine, pausedUntil: null, reason: null })
    .onConflictDoUpdate({ target: engineState.engine, set: { pausedUntil: null, reason: null } })
    .returning()
    .get();
}

/** Both engines, unpaused when no row exists. */
export function listEngineStates(db: Conn): EngineState[] {
  const rows = new Map(db.select().from(engineState).all().map((r) => [r.engine, r]));
  return ENGINES.map((engine) => rows.get(engine) ?? { engine, pausedUntil: null, reason: null });
}

export function getEngineState(db: Conn, engine: Engine): EngineState {
  return listEngineStates(db).find((s) => s.engine === engine)!;
}

export function isEnginePaused(db: Conn, engine: Engine, opts?: ClockOpts): boolean {
  const { pausedUntil } = getEngineState(db, engine);
  return pausedUntil !== null && pausedUntil > nowIso(opts);
}

/** Engines whose pause has expired and should auto-resume (UC-16 step 5). */
export function enginesDueToResume(db: Conn, opts?: ClockOpts): Engine[] {
  return db
    .select({ engine: engineState.engine })
    .from(engineState)
    .where(and(isNotNull(engineState.pausedUntil), lte(engineState.pausedUntil, nowIso(opts))))
    .all()
    .map((r) => r.engine);
}
