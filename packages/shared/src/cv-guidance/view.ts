// The Guidance screen's rule views (§7): each rule's status, its positions with their sources and
// quotes, and how each position fares for Vietnam and for global jobs. Pure: the orchestrator's
// GET /guidance and the web app's mock backend both build the screen with it.
import type { GuidanceRuleView } from "../api/guidance.js";
import { resolveGuidance } from "./resolve.js";
import { isDisputed, plainText, type GuidanceRuleSet, type GuidanceSource } from "./schema.js";

const ref = (s: GuidanceSource) => ({ id: s.id, title: s.title, publisher: s.publisher, url: s.url, repoPath: s.repoPath, retrievedAt: s.retrievedAt, kind: s.kind, market: s.market });

export function guidanceRuleViews(set: GuidanceRuleSet, turnedOff: readonly string[]): GuidanceRuleView[] {
  // A position's standing for Vietnam jobs and for global ones (the market tie-break, §5.5).
  const vn = resolveGuidance(set, { masterContact: { links: ["x"] }, jobMarket: "vn", turnedOff: [] });
  const global = resolveGuidance(set, { masterContact: { links: ["x"] }, jobMarket: "global", turnedOff: [] });
  return set.rules.map((rule) => {
    const v = vn.rules.find((r) => r.ruleId === rule.id)!;
    const g = global.rules.find((r) => r.ruleId === rule.id)!;
    const off = turnedOff.includes(rule.id);
    const status: GuidanceRuleView["status"] = off ? "turned_off" : rule.overriddenBy.length > 0 ? "overridden" : isDisputed(rule) ? "disputed" : "agree";
    const reason = off ? "Turned off by you: not sent to the CV writer or the review." : v.reason === g.reason ? g.reason : `For Vietnam jobs: ${v.reason} For global jobs: ${g.reason}`;
    return {
      ruleId: rule.id,
      topic: rule.topic,
      point: rule.point,
      check: rule.check,
      appliesWhen: rule.appliesWhen,
      overriddenBy: rule.overriddenBy,
      status,
      turnedOff: off,
      reason,
      positions: rule.positions.map((p, i) => {
        const inVn = v.positions[i]!.status !== "not_applied";
        const inGlobal = g.positions[i]!.status !== "not_applied";
        return {
          id: p.id,
          text: p.text,
          hosts: g.positions[i]!.hosts,
          applies: inVn && inGlobal ? ("applied" as const) : inVn ? ("applied_vn" as const) : inGlobal ? ("applied_global" as const) : ("not_applied" as const),
          sources: p.sourceIds
            .map((id) => set.sources.find((s) => s.id === id))
            .filter((s): s is GuidanceSource => s !== undefined)
            .map((s) => ({ ...ref(s), title: s.title ? plainText(s.title, 200) : null, evidence: p.evidence.find((e) => e.sourceId === s.id)?.quote ?? null })),
        };
      }),
    };
  });
}

