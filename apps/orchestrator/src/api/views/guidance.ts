// CV guidance screens (§7): the rule set with its sources and dispositions (Guidance screen), the
// activity log (Activity screen) and the review step's per-language panel. Read-only views: only
// the engine's refresh commits a rule set; Ba's one control is turning a rule off or on (§5.9).
import {
  GuidanceReviewResultSchema,
  LIMITS,
  guidanceRuleViews,
  type ActivityEntry,
  type GuidanceRefreshSummary,
  type GuidanceRuleSet,
  type GuidanceSource,
  type GuidanceView,
  type ReviewGuidance,
} from "@bs-job-agents/shared";
import { listCvVersions, listEvents, type Db } from "../../db/index.js";
import { getGuidanceReview } from "../../db/repos/guidance-reviews.js";
import { currentGuidanceRuleSet, getGuidanceSettings, getGuidanceSnapshot } from "../../db/repos/guidance.js";

const ref = (s: GuidanceSource) => ({ id: s.id, title: s.title, publisher: s.publisher, url: s.url, repoPath: s.repoPath, retrievedAt: s.retrievedAt, kind: s.kind, market: s.market });

function refreshOf(row: { createdAt: string; payload: unknown }): GuidanceRefreshSummary {
  const p = row.payload as { runId: string | null; outcome: GuidanceRefreshSummary["outcome"]; pagesChecked: number; failed: number; rulesChanged: number; error: string | null };
  return { at: row.createdAt, runId: p.runId, outcome: p.outcome, pagesChecked: p.pagesChecked, failed: p.failed, rulesChanged: p.rulesChanged, error: p.error };
}

export function guidanceView(db: Db): GuidanceView {
  const current = currentGuidanceRuleSet(db);
  const settings = getGuidanceSettings(db);
  const refreshes = listEvents(db, { types: ["guidance.refresh"] });
  const last = refreshes.at(-1);
  const success = [...refreshes].reverse().find((r) => (r.payload as { outcome?: string }).outcome !== "failed");
  return {
    snapshot: current?.snapshot ?? null,
    sourceCount: current?.ruleSet.sources.length ?? 0,
    lastRefresh: last ? refreshOf(last) : null,
    lastSuccessAt: success?.createdAt ?? null,
    rules: current ? guidanceRuleViews(current.ruleSet, settings.turnedOff) : [],
  };
}

/** REQ-36: rule added or changed, newest first, with the sources of the snapshot it made. */
export function activityEntries(db: Db): ActivityEntry[] {
  const rows = listEvents(db, { types: ["guidance.rule_added", "guidance.rule_changed"] });
  const snapshots = new Map<number, GuidanceRuleSet | null>();
  const setOf = (n: number) => {
    if (!snapshots.has(n)) snapshots.set(n, getGuidanceSnapshot(db, n)?.ruleSet ?? currentGuidanceRuleSet(db)?.ruleSet ?? null);
    return snapshots.get(n)!;
  };
  return rows
    .map((row): ActivityEntry => {
      const p = row.payload as { snapshot: number; runId: string | null; ruleId: string; point: string; previousText: string; newText: string; sourceIds: string[]; applied: boolean };
      const set = setOf(p.snapshot);
      return {
        id: String(row.id),
        at: row.createdAt,
        kind: row.type === "guidance.rule_added" ? "rule_added" : "rule_changed",
        ruleId: p.ruleId,
        point: p.point,
        previousText: p.previousText,
        newText: p.newText,
        sources: p.sourceIds.map((id) => set?.sources.find((s) => s.id === id)).filter((s): s is GuidanceSource => s !== undefined).map(ref),
        applied: p.applied,
        runId: p.runId,
      };
    })
    .reverse();
}

/** The review panel for one CV version: its stored review and how many guided rounds led to it. */
export function reviewGuidance(db: Db, cv: { id: number; jobId: number; language: string }): ReviewGuidance | null {
  const stored = getGuidanceReview(db, cv.id);
  if (!stored) return null;
  const parsed = GuidanceReviewResultSchema.safeParse(stored.result);
  if (!parsed.success) return null;
  const guided = listCvVersions(db, cv.jobId).filter((v) => v.language === cv.language && getGuidanceReview(db, v.id) !== undefined);
  const rounds = Math.max(1, guided.length);
  return { result: parsed.data, rounds, revisions: rounds - 1, lastRound: rounds >= LIMITS.qaMaxRounds };
}
