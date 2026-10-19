// SEC-25 (CV guidance §5.7): the truth check of a tailored CV, by code, before its PDF is exported
// and before QA. Every bullet and the summary may state only the numbers, percentages, months, years
// and durations its cited facts contain (the same normalising comparison as SEC-15); an item's dates
// line may state only dates its bullets' facts give. A failure fails the tailor attempt (retried; no
// gate round is used). Guidance never changes this check. QA's invented_claim stays the second one.
import type { TailoredCv } from "../bots/cv.js";
import type { TaskFact } from "../domain/master-cv.js";
import { describeClaim, unsupportedClaims, type ClaimProblem } from "./claims.js";

export interface CvClaimProblem {
  /** "summary", or "<section title> › <item heading>" (bullet n, or "dates"). */
  where: string;
  text: string;
  factIds: string[];
  problems: ClaimProblem[];
}

type FactLike = Pick<TaskFact, "id" | "text" | "textVi" | "tags" | "org" | "dates">;

/** Only what SEC-25 names: numbers, months, years, durations (and "Present"); titles are QA's. */
const CHECKED = new Set<ClaimProblem["kind"]>(["number", "month", "duration", "present"]);

function check(text: string, ids: readonly string[], byId: ReadonlyMap<string, FactLike>, datesOnly = false): ClaimProblem[] {
  const facts = ids.map((id) => byId.get(id)).filter((f): f is FactLike => f !== undefined);
  const texts = datesOnly ? [] : facts.flatMap((f) => [f.text, f.textVi ?? "", ...f.tags, f.org ?? ""]);
  const dates = facts.map((f) => f.dates ?? "").filter(Boolean);
  return unsupportedClaims(text, { texts, dates }).filter((p) => CHECKED.has(p.kind));
}

export function checkCvClaims(cv: TailoredCv, facts: readonly FactLike[]): CvClaimProblem[] {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const out: CvClaimProblem[] = [];
  if (cv.summary) {
    const problems = check(cv.summary.text, cv.summary.factIds, byId);
    if (problems.length > 0) out.push({ where: "summary", text: cv.summary.text, factIds: cv.summary.factIds, problems });
  }
  for (const section of cv.sections) {
    for (const item of section.items) {
      const label = `${section.title}${item.heading ? ` › ${item.heading}` : ""}`;
      item.bullets.forEach((b, i) => {
        const problems = check(b.text, b.factIds, byId);
        if (problems.length > 0) out.push({ where: `${label}, bullet ${i + 1}`, text: b.text, factIds: b.factIds, problems });
      });
      const ids = [...new Set(item.bullets.flatMap((b) => b.factIds))];
      if (item.subheading && ids.length > 0) {
        // The dates line: what the item's facts' dates give (SEC-25.AC-1: no month added to "2023-2025").
        const problems = check(item.subheading, ids, byId, true).filter((p) => p.kind !== "duration");
        if (problems.length > 0) out.push({ where: `${label}, dates`, text: item.subheading, factIds: ids, problems });
      }
    }
  }
  return out;
}

/** The attempt's error: what was found where, for the retry and for Ba (no fact text beyond the CV's). */
export function cvClaimsError(problems: readonly CvClaimProblem[]): string {
  const parts = problems.slice(0, 4).map((p) => `${p.where} ${p.problems.map(describeClaim).join(", ")} that its facts (${p.factIds.join(", ")}) do not`);
  const more = problems.length > 4 ? ` and ${problems.length - 4} more` : "";
  return `the truth check failed before QA (SEC-25): ${parts.join("; ")}${more}. State only what the cited facts give; ask Ba with a factRequest for anything missing`;
}
