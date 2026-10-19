// completeGuidanceReview (§5.5, AD-11): the stored review result of one tailored CV round, per
// language. Every rule gets one status and lists its sources (REQ-37.AC-1). The resolver's
// disposition wins, then the deterministic checker, then cv.review. A fix becomes a revision fix
// only when every fact it cites is an active master or derived fact (REQ-38, REQ-39); a needs_fact
// item becomes one fact request for one fact (REQ-37.AC-2, REQ-39.AC-1). Pure.
import { z } from "zod";
import type { GuidanceFactField, GuidanceItem } from "./checks.js";
import { GUIDANCE_TOPICS, GUIDANCE_CHECKS, type GuidanceTopic } from "./schema.js";
import type { ResolvedGuidance, ResolvedRule } from "./resolve.js";

export const GUIDANCE_REVIEW_STATUSES = ["met", "not_met", "needs_fact", "not_applicable", "overridden", "disputed_not_applied", "turned_off", "not_reviewed"] as const;
export const GuidanceReviewStatusSchema = z.enum(GUIDANCE_REVIEW_STATUSES);
export type GuidanceReviewStatus = z.infer<typeof GuidanceReviewStatusSchema>;

export const GuidanceFactFieldSchema = z.enum(["dates", "result", "contact.phone", "detail"]);

export const GuidanceFactRequestSchema = z.object({
  ruleId: z.string().min(1),
  factId: z.string().min(1),
  field: GuidanceFactFieldSchema,
  question: z.string().min(1),
});
export type GuidanceFactRequest = z.infer<typeof GuidanceFactRequestSchema>;

export const GuidanceSourceRefSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  publisher: z.string().nullable(),
  url: z.string().nullable(),
  repoPath: z.string().nullable(),
  retrievedAt: z.string().min(1),
  kind: z.string().min(1),
  market: z.enum(["vn", "global"]),
});

export const GuidanceReviewEntrySchema = z.object({
  ruleId: z.string().min(1),
  topic: z.enum(GUIDANCE_TOPICS),
  check: z.enum(GUIDANCE_CHECKS),
  point: z.string().min(1),
  status: GuidanceReviewStatusSchema,
  reason: z.string(),
  /** Who decided: the resolver (disposition), a deterministic checker, or cv.review. */
  by: z.enum(["resolver", "code", "review"]),
  fixable: z.boolean(),
  fix: z.object({ instruction: z.string().min(1), factIds: z.array(z.string()) }).nullable(),
  factRequests: z.array(GuidanceFactRequestSchema),
  overriddenBy: z.array(z.string()),
  /** The applied position's text (null unless the rule applied). */
  applied: z.string().nullable(),
  positions: z.array(z.object({ id: z.string(), text: z.string(), hosts: z.number().int(), status: z.enum(["applied", "applied_market", "not_applied"]), sourceIds: z.array(z.string()) })),
  sources: z.array(GuidanceSourceRefSchema),
});
export type GuidanceReviewEntry = z.infer<typeof GuidanceReviewEntrySchema>;

export const GuidanceReviewResultSchema = z.object({
  snapshot: z.number().int().positive().nullable(),
  /** Whether cv.review judged this round (else judgement rules are not_reviewed). */
  reviewed: z.boolean(),
  items: z.array(GuidanceReviewEntrySchema),
  /** One per fixable not_met item: what the next round is asked to fix. */
  fixes: z.array(z.object({ ruleId: z.string(), point: z.string(), instruction: z.string(), factIds: z.array(z.string()) })),
  factRequests: z.array(GuidanceFactRequestSchema),
});
export type GuidanceReviewResult = z.infer<typeof GuidanceReviewResultSchema>;

/** The field a reviewer's needs_fact asks for, by the rule it is about. */
export function factFieldFor(rule: Pick<ResolvedRule, "check" | "topic">): GuidanceFactField {
  if (rule.check === "month_year" || rule.topic === "dates") return "dates";
  if (rule.check === "contact_present") return "contact.phone";
  if (rule.topic === ("bullet_content" satisfies GuidanceTopic)) return "result";
  return "detail";
}

export interface ReviewerItem {
  ruleId: string;
  status: "met" | "not_met" | "needs_fact" | "not_applicable";
  reason: string;
  fixable: boolean;
  fix: { instruction: string; factIds: string[] } | null;
  needsFact: { factId: string; question: string } | null;
}

export function completeGuidanceReview(
  resolved: ResolvedGuidance,
  checkerItems: readonly GuidanceItem[],
  reviewerItems: readonly ReviewerItem[] | null,
  activeFactIds: readonly string[],
): GuidanceReviewResult {
  const active = new Set(activeFactIds);
  const items: GuidanceReviewEntry[] = resolved.rules.map((r) => {
    const base = {
      ruleId: r.ruleId,
      topic: r.topic,
      check: r.check,
      point: r.point,
      overriddenBy: r.overriddenBy,
      applied: r.applied?.text ?? null,
      positions: r.positions.map((p) => ({ id: p.id, text: p.text, hosts: p.hosts, status: p.status, sourceIds: p.sourceIds })),
      sources: r.sources,
    };
    const checker = checkerItems.find((i) => i.ruleId === r.ruleId);
    if (r.disposition !== "applied") {
      const measured = checker && r.disposition === "overridden" ? ` ${checker.reason}` : "";
      return { ...base, status: r.disposition, reason: `${r.reason}${measured}`, by: "resolver" as const, fixable: false, fix: null, factRequests: [] };
    }
    if (checker) {
      return { ...base, ...validate(r, checker.status, checker.reason, checker.fixable, checker.fix, checker.factRequests, active), by: "code" as const };
    }
    const reviewer = reviewerItems?.find((i) => i.ruleId === r.ruleId);
    if (!reviewer) {
      return { ...base, status: "not_reviewed" as const, reason: reviewerItems ? "The review did not cover this rule." : "Judged by the CV review on the round shown to you.", by: "review" as const, fixable: false, fix: null, factRequests: [] };
    }
    const requests = reviewer.needsFact ? [{ factId: reviewer.needsFact.factId, field: factFieldFor(r), question: reviewer.needsFact.question }] : [];
    return { ...base, ...validate(r, reviewer.status, reviewer.reason, reviewer.fixable, reviewer.fix, requests, active), by: "review" as const };
  });
  const fixes = items.filter((i) => i.status === "not_met" && i.fixable && i.fix).map((i) => ({ ruleId: i.ruleId, point: i.point, instruction: i.fix!.instruction, factIds: i.fix!.factIds }));
  const factRequests = items.flatMap((i) => i.factRequests);
  return { snapshot: resolved.snapshot, reviewed: reviewerItems !== null, items, fixes, factRequests };
}

function validate(
  rule: ResolvedRule,
  status: ReviewerItem["status"],
  reason: string,
  fixable: boolean,
  fix: ReviewerItem["fix"],
  requests: readonly { factId: string; field: GuidanceFactField; question: string }[],
  active: ReadonlySet<string>,
): Pick<GuidanceReviewEntry, "status" | "reason" | "fixable" | "fix" | "factRequests"> {
  if (status === "not_met") {
    // AD-11: a fix resting on an unknown or inactive fact is dropped (the rule stays not met).
    const ok = fixable && fix !== null && fix.factIds.every((id) => active.has(id));
    return { status, reason: ok || !fixable ? reason : `${reason} (its fix cited a fact this CV may not use, so it was dropped)`, fixable: ok, fix: ok ? fix : null, factRequests: [] };
  }
  if (status === "needs_fact") {
    const kept = requests.filter((q) => q.factId === "contact" ? q.field === "contact.phone" : active.has(q.factId)).map((q) => ({ ruleId: rule.ruleId, ...q }));
    if (kept.length === 0) return { status: "not_met", reason: `${reason} (the fact it asks about is not one this CV may use)`, fixable: false, fix: null, factRequests: [] };
    return { status, reason, fixable: false, fix: null, factRequests: kept };
  }
  return { status, reason, fixable: false, fix: null, factRequests: [] };
}

/** Rules Ba must look at: not met, needs a fact, or disputed and not applied (REQ-40). */
export function guidanceAttention(result: Pick<GuidanceReviewResult, "items">): GuidanceReviewEntry[] {
  const order: Record<string, number> = { not_met: 0, needs_fact: 1, disputed_not_applied: 2 };
  return result.items.filter((i) => i.status in order).sort((a, b) => order[a.status]! - order[b.status]!);
}

/** The gate's pass rule (§5.7): no fixable not_met item remains. */
export const hasFixableMiss = (result: Pick<GuidanceReviewResult, "items">): boolean => result.items.some((i) => i.status === "not_met" && i.fixable);
