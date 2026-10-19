// The mock orchestrator's CV guidance, mirroring apps/orchestrator/src/api/routes/guidance.ts and
// views/guidance.ts: the seed rule set (the VNPT post and the three fetched recruiter pages), Ba's
// Turn off / Turn on, one successful refresh and the seed's activity entries. The rule views are
// built with the same shared policy (guidanceRuleViews).
import {
  GUIDANCE_SEED,
  guidanceRuleViews,
  ruleText,
  type ActivityEntry,
  type GuidanceRefreshSummary,
  type GuidanceRuleSet,
  type GuidanceView,
  type SkillRepairActivityEntry,
} from "@bs-job-agents/shared";
import { ApiRequestError } from "../errors";
import type { MockBackend } from "./backend";

export interface MockGuidanceState {
  ruleSet: GuidanceRuleSet;
  turnedOff: string[];
  lastRefresh: GuidanceRefreshSummary | null;
  lastSuccessAt: string | null;
  activity: ActivityEntry[];
}

const SKILL_OLD = "## 3. Listing page\n- Each card (`.job-item-search-result`): title link `h3.title a`.";
const SKILL_NEW = "## 3. Listing page\n- Each card (`article.job-card`): title link `h3.job-card__title a`.";
const skillBase = () => ({ trigger: null, status: null, reason: null, path: null, previousText: null, newText: null, notApplied: [] as { file: string; change: string }[], canRestore: false, canRetry: false });

/** Skill self-repair (sub-project 4 §7): the illustrative entries of the design's success state. */
export function seedSkillActivity(): ActivityEntry[] {
  const entries: SkillRepairActivityEntry[] = [
    {
      ...skillBase(),
      id: "951",
      at: "2026-10-19T09:00:00.000Z",
      kind: "skill_adopted",
      repairId: "3",
      source: "topcv",
      sourceLabel: "TopCV",
      trigger: "adapter broken: no job cards on the results page (layout changed?) (screenshot: not captured)",
      path: "bots/research/skills/source-topcv/SKILL.md",
      previousText: SKILL_OLD,
      newText: SKILL_NEW,
      notApplied: [{ file: "bots/research/bot.json", change: "new allowed site topcv.com.vn" }],
      canRestore: true,
    },
    {
      ...skillBase(),
      id: "950",
      at: "2026-10-19T08:30:00.000Z",
      kind: "skill_not_adopted",
      repairId: "2",
      source: "itviec",
      sourceLabel: "ITviec",
      trigger: "adapter broken: a posting without its description block (screenshot: not captured)",
      reason: "the validation scan returned 0 jobs",
      newText: "## 4. Job page\n- Full JD: `section.job-details`.",
    },
  ];
  return entries;
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
    activity: [
      ...seedSkillActivity(),
      ...GUIDANCE_SEED.rules
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
    ],
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

/** Mirrors POST /skill-repairs/:id/restore: only the latest adopted entry that can still be restored. */
export function restoreSkill(core: MockBackend, repairId: string): { entries: ActivityEntry[] } {
  const g = stateOf(core);
  const entry = g.activity.find((e): e is SkillRepairActivityEntry => e.kind === "skill_adopted" && e.repairId === repairId);
  if (!entry) throw new ApiRequestError({ status: 404, code: "not_found", message: `there is no skill repair ${repairId}` });
  if (!entry.canRestore) throw new ApiRequestError({ status: 409, code: "conflict", message: "only the latest adopted repair can be restored, while the skill file still holds its text" });
  entry.canRestore = false;
  g.activity = [
    { ...entry, id: `r-${entry.id}`, at: core.nowIso(), kind: "skill_restored", previousText: entry.newText, newText: entry.previousText, notApplied: [], canRestore: false },
    ...g.activity,
  ];
  return { entries: g.activity };
}

/** Mirrors POST /skill-repairs/sources/:source/retry: a new repair starts drafting. */
export function retrySkillRepair(core: MockBackend, source: string): { entries: ActivityEntry[] } {
  const g = stateOf(core);
  const last = g.activity.find((e): e is SkillRepairActivityEntry => e.kind.startsWith("skill") && "source" in e && e.source === source);
  if (!last) throw new ApiRequestError({ status: 404, code: "not_found", message: `there is no skill repair for ${source} to try again` });
  for (const e of g.activity) if (e.kind === "skill_repair_paused" && e.source === source) e.canRetry = false;
  g.activity = [{ ...skillBase(), id: `repair-${g.activity.length}`, at: core.nowIso(), kind: "skill_repairing", repairId: null, source, sourceLabel: last.sourceLabel, trigger: last.trigger, status: "drafting" }, ...g.activity];
  return { entries: g.activity };
}
