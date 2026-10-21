// The mock orchestrator's CV guidance, mirroring apps/orchestrator/src/api/routes/guidance.ts and
// views/guidance.ts: the seed rule set (the VNPT post and the three fetched recruiter pages), Ba's
// Turn off / Turn on, one successful refresh and the seed's activity entries. The rule views are
// built with the same shared policy (guidanceRuleViews).
import { GUIDANCE_SEED, guidanceRuleViews, ruleText, type ActivityEntry, type GuidanceRefreshSummary, type GuidanceRuleSet, type GuidanceView } from "@bs-job-agents/shared";
import { ApiRequestError } from "../errors";
import type { MockBackend } from "./backend";

export interface MockGuidanceState {
  ruleSet: GuidanceRuleSet;
  turnedOff: string[];
  lastRefresh: GuidanceRefreshSummary | null;
  lastSuccessAt: string | null;
  activity: ActivityEntry[];
}

export function seedGuidance(now: string): MockGuidanceState {
  const ref = (id: string) => {
    const s = GUIDANCE_SEED.sources.find((x) => x.id === id)!;
    return { id: s.id, title: s.title, publisher: s.publisher, url: s.url, repoPath: s.repoPath, retrievedAt: s.retrievedAt, kind: s.kind, market: s.market };
  };
  return {
    ruleSet: structuredClone(GUIDANCE_SEED),
    turnedOff: [],
    lastRefresh: { at: now, runId: "13", outcome: "unchanged", pagesChecked: 3, failed: 0, rulesChanged: 0, error: null },
    lastSuccessAt: now,
    activity: GUIDANCE_SEED.rules
      .map((r, i) => ({
        id: String(900 + i),
        at: "2026-10-18T08:00:00.000Z",
        kind: "rule_added" as const,
        ruleId: r.id,
        point: r.point,
        previousText: "",
        newText: ruleText(r),
        sources: [...new Set(r.positions.flatMap((p) => p.sourceIds))].sort().map(ref),
        applied: true,
        runId: null,
      }))
      .reverse(),
  };
}

function stateOf(core: MockBackend): MockGuidanceState {
  core.state.guidance ??= seedGuidance(core.nowIso());
  return core.state.guidance;
}

export function readGuidance(core: MockBackend): GuidanceView {
  const g = stateOf(core);
  return { snapshot: 1, sourceCount: g.ruleSet.sources.length, lastRefresh: g.lastRefresh, lastSuccessAt: g.lastSuccessAt, rules: guidanceRuleViews(g.ruleSet, g.turnedOff) };
}

export function setGuidanceRuleOff(core: MockBackend, ruleId: string, off: boolean): GuidanceView {
  const g = stateOf(core);
  if (!g.ruleSet.rules.some((r) => r.id === ruleId)) throw new ApiRequestError({ status: 404, code: "not_found", message: `there is no CV guidance rule ${ruleId}` });
  g.turnedOff = off ? [...new Set([...g.turnedOff, ruleId])] : g.turnedOff.filter((id) => id !== ruleId);
  return readGuidance(core);
}

export function readActivity(core: MockBackend): { entries: ActivityEntry[] } {
  return { entries: stateOf(core).activity };
}
