// Illustrative CV guidance results for the mock review queue (design screens/review.md states):
// NovaPay's English CV has one rule not met and one needing a fact; Sao Việt's VI and EN CVs meet
// every rule. Built with the shared policy over the seed rule set.
import { GUIDANCE_SEED, completeGuidanceReview, resolveGuidance, type GuidanceItem, type ReviewGuidance, type ReviewerItem } from "@bs-job-agents/shared";

const met = (ruleId: string): ReviewerItem => ({ ruleId, status: "met", reason: "Met.", fixable: false, fix: null, needsFact: null });
const code = (ruleId: string, over: Partial<GuidanceItem> = {}): GuidanceItem => ({ ruleId, status: "met", reason: "Met.", fixable: false, fix: null, factRequests: [], ...over });

function result(reviewer: ReviewerItem[], checks: GuidanceItem[], rounds: number): ReviewGuidance {
  const resolved = resolveGuidance(GUIDANCE_SEED, { masterContact: { links: ["https://www.linkedin.com/in/bahuynh"] }, jobMarket: "global", turnedOff: [] }, 1);
  const items = resolved.rules.filter((r) => r.check === "judgement").map((r) => reviewer.find((x) => x.ruleId === r.ruleId) ?? met(r.ruleId));
  return { result: completeGuidanceReview(resolved, checks, items, ["grad-1", "grad-2"]), rounds, revisions: rounds - 1, lastRound: rounds >= 3 };
}

const ALL_CHECKS = ["dates-month-year", "contact-complete", "links-profile", "skills-practical-experience", "length-pages"];

export function novaPayGuidance(): ReviewGuidance {
  return result(
    [{ ruleId: "order-most-relevant-first", status: "not_met", reason: "The finance workflow comes before the React app the JD asks for, and no fact lets the order change truthfully.", fixable: false, fix: null, needsFact: null }],
    ALL_CHECKS.map((id) =>
      id === "dates-month-year"
        ? code(id, { status: "needs_fact", reason: "1 fact gives only years; the CV keeps the years until you add the months.", factRequests: [{ factId: "grad-2", field: "dates", question: 'What were the start and end months of "Owned a multi-country purchase order system…" (2023 – 2025)?' }] })
        : code(id),
    ),
    2,
  );
}

export const allMetGuidance = (): ReviewGuidance => result([], ALL_CHECKS.map((id) => code(id)), 1);
