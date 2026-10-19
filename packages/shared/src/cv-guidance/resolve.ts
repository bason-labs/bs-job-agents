// resolveGuidance (§5.5, AD-11): one disposition per rule, by code, in this order: turned off by
// Ba; overridden by a CV constraint (a QA hard fail or a CV layout rule, REQ-34); not applicable
// (appliesWhen false, REQ-37.AC-4); a disputed rule applies the position backed by the most
// distinct publisher hosts (REQ-33, SEC-23), a tie at the top is broken by the job's market when
// exactly one tied position has a source of that market, else nothing is applied; a single position
// is applied. Pure.
import { z } from "zod";
import { distinctHosts, isPinnedPosition, type CvConstraintId, type GuidanceCheck, type GuidanceMarket, type GuidanceRuleSet, type GuidanceSource, type GuidanceTopic } from "./schema.js";

export const GUIDANCE_DISPOSITIONS = ["applied", "turned_off", "overridden", "not_applicable", "disputed_not_applied"] as const;
export const GuidanceDispositionSchema = z.enum(GUIDANCE_DISPOSITIONS);
export type GuidanceDisposition = z.infer<typeof GuidanceDispositionSchema>;

export type PositionStatus = "applied" | "applied_market" | "not_applied";

/** A source as Ba sees it (plain text; the web makes the url a link only if https). */
export interface GuidanceSourceRef {
  id: string;
  title: string | null;
  publisher: string | null;
  url: string | null;
  repoPath: string | null;
  retrievedAt: string;
  kind: GuidanceSource["kind"];
  market: GuidanceMarket;
}

export interface ResolvedPosition {
  id: string;
  text: string;
  sourceIds: string[];
  /** Distinct publisher hosts behind it (SEC-23). */
  hosts: number;
  status: PositionStatus;
}

export interface ResolvedRule {
  ruleId: string;
  topic: GuidanceTopic;
  point: string;
  check: GuidanceCheck;
  disposition: GuidanceDisposition;
  /** The position tailor follows and the review checks (null unless applied). */
  applied: { id: string; text: string } | null;
  positions: ResolvedPosition[];
  overriddenBy: CvConstraintId[];
  /** One sentence: why this disposition. */
  reason: string;
  sources: GuidanceSourceRef[];
}

export interface ResolvedGuidance {
  /** The snapshot it was resolved from (null when none is stored). */
  snapshot: number | null;
  market: GuidanceMarket;
  rules: ResolvedRule[];
}

export interface GuidanceContext {
  /** The master CV's contact (links decide has_profile_link). */
  masterContact: { links: readonly string[] } | null;
  jobMarket: GuidanceMarket;
  /** Rule ids Ba turned off (§5.9). */
  turnedOff: readonly string[];
}

/** VN when the JD is Vietnamese or the job is in Vietnam, else global (§5.5 step 5). */
export function jobMarketOf(job: { language?: string | null; location?: string | null }): GuidanceMarket {
  if ((job.language ?? "").toLowerCase() === "vi") return "vn";
  return /viet\s*nam|việt nam|ho chi minh|hồ chí minh|hcmc|ha\s*noi|hà nội|da\s*nang|đà nẵng|saigon|sài gòn/i.test(job.location ?? "") ? "vn" : "global";
}

const sourceRef = (s: GuidanceSource): GuidanceSourceRef => ({ id: s.id, title: s.title, publisher: s.publisher, url: s.url, repoPath: s.repoPath, retrievedAt: s.retrievedAt, kind: s.kind, market: s.market });

export function resolveGuidance(set: GuidanceRuleSet, ctx: GuidanceContext, snapshot: number | null = null): ResolvedGuidance {
  const off = new Set(ctx.turnedOff);
  const hasLink = (ctx.masterContact?.links ?? []).length > 0;
  const rules = set.rules.map((rule): ResolvedRule => {
    const ids = [...new Set(rule.positions.flatMap((p) => p.sourceIds))];
    const sources = ids.map((id) => set.sources.find((s) => s.id === id)).filter((s): s is GuidanceSource => s !== undefined).map(sourceRef);
    const positions: ResolvedPosition[] = rule.positions.map((p) => ({ id: p.id, text: p.text, sourceIds: [...p.sourceIds], hosts: distinctHosts(set, p).length, status: "not_applied" }));
    const base = { ruleId: rule.id, topic: rule.topic, point: rule.point, check: rule.check, overriddenBy: [...rule.overriddenBy], positions, sources };
    const none = (disposition: GuidanceDisposition, reason: string): ResolvedRule => ({ ...base, disposition, applied: null, reason });
    if (off.has(rule.id)) return none("turned_off", "Turned off by you: not sent to the CV writer or the review.");
    if (rule.overriddenBy.length > 0) return none("overridden", `Overridden by ${rule.overriddenBy.join(", ")}: that constraint always wins.`);
    if (rule.appliesWhen === "has_profile_link" && !hasLink) return none("not_applicable", "Your master CV has no LinkedIn, GitHub or portfolio link.");
    const apply = (index: number, status: PositionStatus, reason: string): ResolvedRule => {
      positions[index]!.status = status;
      return { ...base, disposition: "applied", applied: { id: positions[index]!.id, text: positions[index]!.text }, reason };
    };
    if (positions.length === 1) return apply(0, "applied", "One position, so it applies.");
    // F2: a refresh position beats a pinned one (the VNPT post) only with 2 or more distinct ICANN hosts.
    const pinned = rule.positions.findIndex((p) => isPinnedPosition(set, p));
    const icannHosts = (i: number) => distinctHosts(set, rule.positions[i]!).filter((h) => !h.startsWith("attachment:")).length;
    const guard = (r: ResolvedRule): ResolvedRule => {
      if (pinned < 0 || r.disposition !== "applied" || !r.applied) return r;
      const winner = positions.findIndex((p) => p.id === r.applied!.id);
      if (winner === pinned || isPinnedPosition(set, rule.positions[winner]!) || icannHosts(winner) >= 2) return r;
      for (const p of positions) p.status = "not_applied";
      return apply(pinned, "applied", "Disputed: a refresh position needs 2 or more distinct publisher hosts to replace the pinned recruiter post, so the post's position applies.");
    };
    const top = Math.max(...positions.map((p) => p.hosts));
    const tied = positions.map((p, i) => ({ p, i })).filter((x) => x.p.hosts === top);
    if (tied.length === 1) {
      const n = top;
      return guard(apply(tied[0]!.i, "applied", `Disputed: this position has the most distinct sources (${n} ${n === 1 ? "host" : "hosts"}).`));
    }
    const marketMatch = tied.filter((x) => x.p.sourceIds.some((id) => set.sources.find((s) => s.id === id)?.market === ctx.jobMarket));
    if (marketMatch.length === 1) {
      const where = ctx.jobMarket === "vn" ? "Vietnam" : "global";
      return guard(apply(marketMatch[0]!.i, "applied_market", `Disputed and tied at ${top} ${top === 1 ? "host" : "hosts"}: the position with a ${where} source applies for this job.`));
    }
    return none("disputed_not_applied", `Disputed and tied at ${top} ${top === 1 ? "host" : "hosts"} each, with no market tie-break: neither position applies.`);
  });
  return { snapshot, market: ctx.jobMarket, rules };
}

/** What cv.tailor follows: the applied positions only, with their rule ids (§5.7). */
export function appliedGuidance(resolved: ResolvedGuidance): { ruleId: string; point: string; text: string }[] {
  return resolved.rules.filter((r) => r.disposition === "applied" && r.applied).map((r) => ({ ruleId: r.ruleId, point: r.point, text: r.applied!.text }));
}
