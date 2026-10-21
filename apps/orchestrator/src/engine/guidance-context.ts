// CV guidance (§5.5, §5.7): the rule set as one job's tailor gate sees it, resolved by code:
// Ba's turned-off rules, the CV constraints, appliesWhen against the master contact, and disputes
// by distinct hosts with the job's market as the tie-break. Read-only: the gate never writes the
// rule set or the master CV (AD-13); only guidance-refresh.ts commits a snapshot.
import { appliedGuidance, jobMarketOf, resolveGuidance, type GuidanceRuleInput, type ResolvedGuidance } from "@bs-job-agents/shared";
import { getJob, type Conn } from "../db/index.js";
import { currentGuidanceRuleSet, getGuidanceSettings } from "../db/repos/guidance.js";
import type { EngineCore } from "./core.js";

/** The resolved guidance for a job, or null when guidance is not wired or the set is empty. */
export function guidanceForJob(core: EngineCore, conn: Conn, jobId: number): ResolvedGuidance | null {
  if (!core.deps.guidance) return null;
  const current = currentGuidanceRuleSet(conn);
  if (!current || current.ruleSet.rules.length === 0) return null;
  const job = getJob(conn, jobId);
  let contact: { links: readonly string[] } | null = null;
  try {
    contact = core.deps.masterCv.read?.()?.contact ?? null;
  } catch {
    contact = null;
  }
  return resolveGuidance(current.ruleSet, { masterContact: contact, jobMarket: jobMarketOf({ language: job?.language ?? null, location: job?.location ?? null }), turnedOff: getGuidanceSettings(conn).turnedOff }, current.snapshot);
}

/** What cv.tailor follows: the applied positions (§5.7). */
export function tailorGuidance(resolved: ResolvedGuidance | null): GuidanceRuleInput[] | undefined {
  if (!resolved) return undefined;
  const applied = appliedGuidance(resolved);
  return applied.length > 0 ? applied : undefined;
}

/** What cv.review judges: the applied judgement rules only (deterministic ones are code's). */
export function reviewRules(resolved: ResolvedGuidance): GuidanceRuleInput[] {
  return resolved.rules.filter((r) => r.disposition === "applied" && r.check === "judgement" && r.applied).map((r) => ({ ruleId: r.ruleId, point: r.point, text: r.applied!.text }));
}
