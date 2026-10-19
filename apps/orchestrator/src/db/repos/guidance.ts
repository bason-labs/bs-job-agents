// CV guidance store (AD-10): the one reader and writer of guidance_rule_sets, plus Ba's guidance
// settings (rules he turned off, §5.9), the discovery date and the refresh lock. Snapshots are
// append-only (triggers refuse UPDATE and DELETE); a commit writes the snapshot and one activity
// event per added or changed rule in one transaction, so a failed commit leaves the previous
// snapshot in force (REQ-36, SEC-24).
import { GuidanceRuleSetSchema, diffRuleSets, type GuidanceChange, type GuidanceRuleSet, type GuidanceSnapshot } from "@bs-job-agents/shared";
import { desc, eq } from "drizzle-orm";
import type { Conn } from "../client.js";
import { guidanceRuleSets, guidanceSettings } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import { appendAppEvent } from "./events.js";

/** The current snapshot (the highest number), or null before the first commit. */
export function currentGuidanceRuleSet(db: Conn): GuidanceSnapshot | null {
  const row = db.select().from(guidanceRuleSets).orderBy(desc(guidanceRuleSets.snapshot)).limit(1).get();
  if (!row) return null;
  const parsed = GuidanceRuleSetSchema.safeParse(row.ruleSet);
  // A stored set that no longer validates is never used half-way: callers treat it as none.
  if (!parsed.success) return null;
  return { snapshot: row.snapshot, createdAt: row.createdAt, runId: row.runId, ruleSet: parsed.data };
}

export function getGuidanceSnapshot(db: Conn, snapshot: number): GuidanceSnapshot | null {
  const row = db.select().from(guidanceRuleSets).where(eq(guidanceRuleSets.snapshot, snapshot)).get();
  const parsed = row ? GuidanceRuleSetSchema.safeParse(row.ruleSet) : null;
  return row && parsed?.success ? { snapshot: row.snapshot, createdAt: row.createdAt, runId: row.runId, ruleSet: parsed.data } : null;
}

export interface CommitGuidanceInput {
  runId: number | null;
  ruleSet: GuidanceRuleSet;
  /** For tests of the failure path (SEC-24.AC-3): throws after the events, inside the transaction. */
  failAfterEvents?: () => void;
}

export interface CommitGuidanceResult {
  snapshot: number;
  changes: GuidanceChange[];
}

/**
 * Append a snapshot (one higher than the last) and its activity events, atomically. The changes
 * are computed from the previous snapshot (diffRuleSets), never taken from the caller.
 */
export function commitGuidanceRuleSet(db: Conn, input: CommitGuidanceInput, opts?: ClockOpts): CommitGuidanceResult {
  const ruleSet = GuidanceRuleSetSchema.parse(input.ruleSet);
  return db.transaction((tx) => {
    const previous = currentGuidanceRuleSet(tx);
    const snapshot = (previous?.snapshot ?? 0) + 1;
    const createdAt = nowIso(opts);
    tx.insert(guidanceRuleSets).values({ snapshot, runId: input.runId, ruleSet, createdAt }).run();
    const changes = diffRuleSets(previous?.ruleSet ?? null, ruleSet);
    for (const c of changes) {
      const entry = { snapshot, runId: input.runId === null ? null : String(input.runId), ruleId: c.ruleId, point: c.point, previousText: c.previousText, newText: c.newText, sourceIds: c.sourceIds, applied: true };
      appendAppEvent(tx, c.kind === "rule_added" ? { type: "guidance.rule_added", ...entry } : { type: "guidance.rule_changed", ...entry }, { now: new Date(createdAt) });
    }
    input.failAfterEvents?.();
    return { snapshot, changes };
  });
}

// ---------------------------------------------------------------- settings

export interface GuidanceSettings {
  turnedOff: string[];
  lastDiscoveryAt: string | null;
  lockRunId: number | null;
  lockAt: string | null;
}

export function getGuidanceSettings(db: Conn): GuidanceSettings {
  const row = db.select().from(guidanceSettings).where(eq(guidanceSettings.id, 1)).get();
  return { turnedOff: row?.turnedOff ?? [], lastDiscoveryAt: row?.lastDiscoveryAt ?? null, lockRunId: row?.lockRunId ?? null, lockAt: row?.lockAt ?? null };
}

function updateSettings(db: Conn, patch: Partial<GuidanceSettings>): GuidanceSettings {
  const next = { ...getGuidanceSettings(db), ...patch };
  db.insert(guidanceSettings)
    .values({ id: 1, ...next })
    .onConflictDoUpdate({ target: guidanceSettings.id, set: next })
    .run();
  return next;
}

/** §5.9: Ba turns a rule off (true) or on (false). A refresh never changes this. */
export function setGuidanceRuleOff(db: Conn, ruleId: string, off: boolean): GuidanceSettings {
  const current = new Set(getGuidanceSettings(db).turnedOff);
  if (off) current.add(ruleId);
  else current.delete(ruleId);
  return updateSettings(db, { turnedOff: [...current].sort() });
}

export function markGuidanceDiscovery(db: Conn, at: string): void {
  updateSettings(db, { lastDiscoveryAt: at });
}

/**
 * The refresh lock (one refresh at a time across runs, SEC-24): taken when free, held by this run,
 * or older than `staleMs` (a crashed refresh). Returns the run that holds it after the call.
 */
export function takeGuidanceLock(db: Conn, runId: number, now: Date, staleMs: number): { held: boolean; holder: number | null } {
  return db.transaction((tx) => {
    const s = getGuidanceSettings(tx);
    const stale = s.lockAt === null || now.getTime() - Date.parse(s.lockAt) > staleMs;
    if (s.lockRunId === null || s.lockRunId === runId || stale) {
      updateSettings(tx, { lockRunId: runId, lockAt: now.toISOString() });
      return { held: true, holder: runId };
    }
    return { held: false, holder: s.lockRunId };
  });
}

export function releaseGuidanceLock(db: Conn, runId: number): void {
  const s = getGuidanceSettings(db);
  if (s.lockRunId === runId) updateSettings(db, { lockRunId: null, lockAt: null });
}

/** Whether another run holds a fresh lock (a refresh in progress elsewhere). */
export function guidanceLockHolder(db: Conn, now: Date, staleMs: number): number | null {
  const s = getGuidanceSettings(db);
  if (s.lockRunId === null || s.lockAt === null || now.getTime() - Date.parse(s.lockAt) > staleMs) return null;
  return s.lockRunId;
}
