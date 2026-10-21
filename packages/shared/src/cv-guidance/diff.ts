// diffRuleSets (AD-11): the activity entries a commit writes, one per added or changed rule, with
// the previous and new text and the sources (REQ-36). Rule ids, text and source ids only: never page
// text, tokens or contact data (SEC-24.AC-4). Pure.
import { ruleText, type GuidanceRuleSet } from "./schema.js";
import type { GuidanceChange } from "./screen.js";

const sourcesOf = (rule: GuidanceRuleSet["rules"][number]) => [...new Set(rule.positions.flatMap((p) => p.sourceIds))].sort();

export function diffRuleSets(previous: GuidanceRuleSet | null, next: GuidanceRuleSet): GuidanceChange[] {
  const out: GuidanceChange[] = [];
  for (const rule of next.rules) {
    const before = previous?.rules.find((r) => r.id === rule.id);
    const sourceIds = sourcesOf(rule);
    if (!before) {
      out.push({ kind: "rule_added", ruleId: rule.id, point: rule.point, previousText: "", newText: ruleText(rule), sourceIds });
      continue;
    }
    if (ruleText(before) !== ruleText(rule) || sourcesOf(before).join(",") !== sourceIds.join(",") || before.overriddenBy.join(",") !== rule.overriddenBy.join(",")) {
      out.push({ kind: "rule_changed", ruleId: rule.id, point: rule.point, previousText: ruleText(before), newText: ruleText(rule), sourceIds });
    }
  }
  return out;
}
