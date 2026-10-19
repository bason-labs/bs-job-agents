// SEC-25 (CV guidance §5.7): the truth check of a tailored CV, by code, before its PDF is exported
// and before QA. A failure fails the tailor attempt (retried; no gate round is used). Guidance never
// changes this check; QA's invented_claim stays the second one. Every bullet and the summary may
// state only what its cited facts give, after the same normalising comparison as SEC-15:
// - numbers, percentages, months, years and durations (an item's dates line: only its facts' dates);
// - known skill and tool terms (the sub-project 2 term table, termsIn): only from the cited facts;
// - job-title words and capitalised names (employers, products): from the cited facts or, for a
//   title or a name, anywhere in Ba's active facts (his master CV, derived facts included).
import type { TailoredCv } from "../bots/cv.js";
import { factNames, termIn, termsIn } from "../cv-derive/implications.js";
import type { TaskFact } from "../domain/master-cv.js";
import { capitalisedNames, describeClaim, titlesIn, unsupportedClaims, type ClaimProblem } from "./claims.js";

export type CvClaimKind = ClaimProblem["kind"] | "skill" | "name";
export interface CvClaimIssue {
  kind: CvClaimKind;
  value: string;
}

export interface CvClaimProblem {
  /** "summary", or "<section title> › <item heading>" (bullet n, or "dates"). */
  where: string;
  text: string;
  factIds: string[];
  problems: CvClaimIssue[];
}

type FactLike = Pick<TaskFact, "id" | "text" | "textVi" | "tags" | "org" | "dates">;

const NUMERIC = new Set<ClaimProblem["kind"]>(["number", "month", "duration", "present"]);

const corpusOf = (facts: readonly FactLike[]) => facts.flatMap((f) => [f.text, f.textVi ?? "", ...f.tags, f.org ?? ""]).join("\n");

/** Ba's own words beyond his facts that a title or name may come from: his headline options (EN and VI). */
export interface CvClaimContext {
  headlines?: readonly string[];
}

function check(text: string, ids: readonly string[], byId: ReadonlyMap<string, FactLike>, all: readonly FactLike[], ctx: CvClaimContext, only: "all" | "names" = "all"): CvClaimIssue[] {
  const cited = ids.map((id) => byId.get(id)).filter((f): f is FactLike => f !== undefined);
  const texts = cited.flatMap((f) => [f.text, f.textVi ?? "", ...f.tags, f.org ?? ""]);
  const dates = cited.map((f) => f.dates ?? "").filter(Boolean);
  const out: CvClaimIssue[] = only === "all" ? unsupportedClaims(text, { texts, dates }).filter((p) => NUMERIC.has(p.kind)) : [];
  // Skills and tools: a cited fact names the term (factNames: as a tool, never as the employer).
  const terms = termsIn(text);
  if (only === "all") for (const term of terms) if (!cited.some((f) => factNames(f, term))) out.push({ kind: "skill", value: term });
  // Titles: the cited facts, any of Ba's facts, or his own headline options use the title word.
  const master = `${corpusOf(all)}\n${(ctx.headlines ?? []).join("\n")}`;
  const allTitles = new Set([...titlesIn(texts.join("\n")), ...titlesIn(master)]);
  for (const t of titlesIn(text)) if (!allTitles.has(t)) out.push({ kind: "title", value: t });
  // Employers and other names: written in the cited facts or somewhere in Ba's facts.
  const known = `${texts.join("\n")}\n${master}`;
  for (const name of new Set(capitalisedNames(text))) {
    if (terms.some((t) => termIn(t, name))) continue;
    if (!termIn(name, known)) out.push({ kind: "name", value: name });
  }
  return out.filter((p, i) => out.findIndex((q) => q.kind === p.kind && q.value === p.value) === i);
}

export function checkCvClaims(cv: TailoredCv, facts: readonly FactLike[], ctx: CvClaimContext = {}): CvClaimProblem[] {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const out: CvClaimProblem[] = [];
  if (cv.summary) {
    const problems = check(cv.summary.text, cv.summary.factIds, byId, facts, ctx);
    if (problems.length > 0) out.push({ where: "summary", text: cv.summary.text, factIds: cv.summary.factIds, problems });
  }
  for (const section of cv.sections) {
    for (const item of section.items) {
      const label = `${section.title}${item.heading ? ` › ${item.heading}` : ""}`;
      item.bullets.forEach((b, i) => {
        const problems = check(b.text, b.factIds, byId, facts, ctx);
        if (problems.length > 0) out.push({ where: `${label}, bullet ${i + 1}`, text: b.text, factIds: b.factIds, problems });
      });
      const ids = [...new Set(item.bullets.flatMap((b) => b.factIds))];
      // The heading (role and employer): its title words and names, like a bullet's.
      if (item.heading) {
        const problems = check(item.heading, ids, byId, facts, ctx, "names");
        if (problems.length > 0) out.push({ where: `${label}, heading`, text: item.heading, factIds: ids, problems });
      }
      if (item.subheading && ids.length > 0) {
        // The dates line: what the item's facts' dates give (SEC-25.AC-1: no month added to "2023-2025").
        const dates = ids.map((id) => byId.get(id)?.dates ?? "").filter(Boolean);
        const problems = unsupportedClaims(item.subheading, { texts: [], dates }).filter((p) => NUMERIC.has(p.kind) && p.kind !== "duration");
        if (problems.length > 0) out.push({ where: `${label}, dates`, text: item.subheading, factIds: ids, problems });
      }
    }
  }
  return out;
}

const describe = (p: CvClaimIssue): string => (p.kind === "skill" ? `names the skill ${p.value}` : p.kind === "name" ? `names ${p.value}` : describeClaim(p as ClaimProblem));

/** The attempt's error: what was found where, for the retry and for Ba (no fact text beyond the CV's). */
export function cvClaimsError(problems: readonly CvClaimProblem[]): string {
  const parts = problems.slice(0, 4).map((p) => `${p.where} ${p.problems.map(describe).join(", ")} that its facts (${p.factIds.join(", ")}) do not`);
  const more = problems.length > 4 ? ` and ${problems.length - 4} more` : "";
  return `the truth check failed before QA (SEC-25): ${parts.join("; ")}${more}. State only what the cited facts give; ask Ba with a factRequest for anything missing`;
}
