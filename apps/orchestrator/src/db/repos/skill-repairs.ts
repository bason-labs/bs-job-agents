// Skill self-repair (sub-project 4; AD-7, SEC-13) and the API path's health (§5.8). Only the engine's
// skill-repair flow and the board-API task runner write these tables.
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import type { Conn } from "../client.js";
import { ACTIVE_SKILL_REPAIR_STATUSES, skillRepairs, skillRepairSources, sourceApiHealth, type SkillRepairStatus } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";

export type SkillRepair = typeof skillRepairs.$inferSelect;
export type SkillRepairPatch = Partial<Omit<typeof skillRepairs.$inferInsert, "id" | "source" | "createdAt">>;

export interface NewSkillRepair {
  source: string;
  trigger: string;
  status: Extract<SkillRepairStatus, "queued" | "drafting">;
  taskId: number | null;
  manual?: boolean;
}

/** The new row, or null when the source already has an active repair (the unique partial index). */
export function insertSkillRepair(db: Conn, input: NewSkillRepair, opts?: ClockOpts): SkillRepair | null {
  return (
    db
      .insert(skillRepairs)
      .values({ source: input.source, trigger: input.trigger, status: input.status, taskId: input.taskId, manual: input.manual ?? false, createdAt: nowIso(opts) })
      .onConflictDoNothing()
      .returning()
      .get() ?? null
  );
}

export function getSkillRepair(db: Conn, id: number): SkillRepair | undefined {
  return db.select().from(skillRepairs).where(eq(skillRepairs.id, id)).get();
}

export function updateSkillRepair(db: Conn, id: number, patch: SkillRepairPatch): SkillRepair {
  const row = db.update(skillRepairs).set(patch).where(eq(skillRepairs.id, id)).returning().get();
  if (!row) throw new Error(`there is no skill repair ${id}`);
  return row;
}

/** Repairs not finished yet (queued, drafting, validating, adopting), oldest first. */
export function listActiveSkillRepairs(db: Conn): SkillRepair[] {
  return db
    .select()
    .from(skillRepairs)
    .where(inArray(skillRepairs.status, [...ACTIVE_SKILL_REPAIR_STATUSES]))
    .orderBy(asc(skillRepairs.id))
    .all();
}

/** Every repair, oldest first (optionally of one source). */
export function listSkillRepairs(db: Conn, filter: { source?: string } = {}): SkillRepair[] {
  return db
    .select()
    .from(skillRepairs)
    .where(filter.source ? eq(skillRepairs.source, filter.source) : undefined)
    .orderBy(asc(skillRepairs.id))
    .all();
}

/** The source's latest repair, if any. */
export function latestSkillRepair(db: Conn, source: string): SkillRepair | undefined {
  return db.select().from(skillRepairs).where(eq(skillRepairs.source, source)).orderBy(desc(skillRepairs.id)).limit(1).get();
}

/** Attempts for a source created at or after `sinceIso`: automatic ones, or Ba's retries (`manual`). */
export function countSkillRepairsSince(db: Conn, source: string, sinceIso: string, opts: { manual?: boolean } = {}): number {
  return db
    .select({ id: skillRepairs.id })
    .from(skillRepairs)
    .where(and(eq(skillRepairs.source, source), gte(skillRepairs.createdAt, sinceIso), eq(skillRepairs.manual, opts.manual ?? false)))
    .all().length;
}

export interface SkillRepairSourceState {
  source: string;
  failures: number;
  pausedAt: string | null;
}

export function getSkillRepairSource(db: Conn, source: string): SkillRepairSourceState {
  return db.select().from(skillRepairSources).where(eq(skillRepairSources.source, source)).get() ?? { source, failures: 0, pausedAt: null };
}

export function setSkillRepairSource(db: Conn, state: SkillRepairSourceState): SkillRepairSourceState {
  return db
    .insert(skillRepairSources)
    .values(state)
    .onConflictDoUpdate({ target: skillRepairSources.source, set: { failures: state.failures, pausedAt: state.pausedAt } })
    .returning()
    .get();
}

export interface SourceApiHealth {
  source: string;
  brokenSince: string | null;
  lastReason: string | null;
  updatedAt: string;
}

export function getSourceApiHealth(db: Conn, source: string): SourceApiHealth | undefined {
  return db.select().from(sourceApiHealth).where(eq(sourceApiHealth.source, source)).get();
}

/** Mark the board's API broken; returns true when it was healthy before (the notice is posted once). */
export function markSourceApiBroken(db: Conn, source: string, reason: string, opts?: ClockOpts): boolean {
  const now = nowIso(opts);
  const was = getSourceApiHealth(db, source);
  db.insert(sourceApiHealth)
    .values({ source, brokenSince: was?.brokenSince ?? now, lastReason: reason, updatedAt: now })
    .onConflictDoUpdate({ target: sourceApiHealth.source, set: { brokenSince: was?.brokenSince ?? now, lastReason: reason, updatedAt: now } })
    .run();
  return !was?.brokenSince;
}

/** Mark the board's API healthy; returns true when it was broken before (the recovery notice is posted once). */
export function markSourceApiHealthy(db: Conn, source: string, opts?: ClockOpts): boolean {
  const was = getSourceApiHealth(db, source);
  if (!was?.brokenSince) return false;
  db.update(sourceApiHealth).set({ brokenSince: null, updatedAt: nowIso(opts) }).where(eq(sourceApiHealth.source, source)).run();
  return true;
}
