// cv.derive (CV auto-extend §5.5–5.6): CV drafts master facts that Ba's own facts support or imply
// for a job's gaps, with no tools; the implication table drafts the obvious ones by code first. Every
// draft, from the table or the model, goes through screenDerivedFacts: pure code that rejects a
// draft citing nothing (or a missing or derived fact), pointing at words its facts do not contain,
// implying across categories, or stating a number, year, month, duration, title or employer its
// facts lack. The bot's org and dates are never used: buildDerivedFacts copies them from the facts.
import { z } from "zod";
import {
  DerivedRelationSchema,
  activeFacts,
  factSourceHash,
  isDerivedFact,
  type DerivedRelation,
  type Fact,
  type MasterCv,
} from "../domain/master-cv.js";
import {
  analyseGap,
  categoriesOf,
  factNames,
  termIn,
  termsIn,
  type ImplicationTable,
  type LearnedImplications,
  type TableDerivation,
} from "../cv-derive/implications.js";
import { capitalisedNames, claimsIn, describeClaim, lower, titlesIn, unsupportedClaims } from "../truth/claims.js";
import { botEnvelopeShape } from "./self-check.js";

/** At most this many derived facts per job and run (SEC-16.AC-3), table and model together. */
export const DERIVE_MAX_FACTS = 5;
/** Gaps per cv.derive task. */
export const DERIVE_MAX_GAPS = 20;

/** CV's self-check for cv.derive (bots/cv/bot.json selfCheckByKind.derive). */
export const DERIVE_SELF_CHECK = [
  "Every draft cites only Ba's own facts from the input",
  "fromTerms are copied word for word from the cited facts",
  "No number, date, duration, title or employer the cited facts do not contain",
  "No draft for a requirement the facts do not support or imply",
] as const;

export const DerivedDraftSchema = z.strictObject({
  requirement: z.string().min(1).describe("The gap this draft answers, copied from gaps"),
  type: z.enum(["skill", "experience"]).describe("skill: the bare skill name; experience: one CV line built from the cited facts"),
  text: z.string().min(1).describe("English: the bare skill name (e.g. Redux), or a CV line using only the cited facts' words"),
  textVi: z.string().min(1).nullable().describe("Vietnamese wording (the same skill name for a skill); null if none"),
  tags: z.array(z.string().min(1)).describe("Short lowercase tags, e.g. redux"),
  restsOn: z
    .array(z.strictObject({ factId: z.string().min(1).describe("Id of one of Ba's facts in the input"), relation: DerivedRelationSchema }))
    .describe("The facts it rests on: supports (the fact says it) or implied_from (well-known implication)"),
  fromTerms: z.array(z.string().min(1)).describe("The exact words in the cited facts that carry the support, e.g. React, Next.js"),
  rationale: z.string().min(1).describe("One sentence: why the facts support or imply it"),
});
export type DerivedDraft = z.infer<typeof DerivedDraftSchema>;

export const DeriveOutputSchema = z.strictObject({
  drafts: z.array(DerivedDraftSchema).max(DERIVE_MAX_FACTS).describe("0–5 drafts; none for a gap the facts do not support"),
  ...botEnvelopeShape,
});
export type DeriveOutput = z.infer<typeof DeriveOutputSchema>;

/** A draft with where it came from. */
export type DeriveCandidate = DerivedDraft & { via: "table" | "model" };

export const RejectedDerivedDraftSchema = z.object({
  requirement: z.string(),
  text: z.string(),
  /** The fact ids it cited (never contact data, SEC-15.AC-4). */
  restsOn: z.array(z.string()),
  /** e.g. "says 10, which grad-12 does not say". */
  reasons: z.array(z.string().min(1)).min(1),
  via: z.enum(["table", "model"]),
});
export type RejectedDerivedDraft = z.infer<typeof RejectedDerivedDraftSchema>;

export interface DeriveScreenContext {
  /** The master CV as it is now (re-read before every write, SEC-17). */
  cv: Pick<MasterCv, "facts">;
  table: ImplicationTable;
  /** Names a derived fact never states, such as the job's own company. */
  forbiddenNames?: readonly string[];
  /** How many may still be accepted for this job (default DERIVE_MAX_FACTS). */
  limit?: number;
}

const fold = (s: string): string => lower(s).replace(/\s+/g, " ").trim();
const plural = (ids: readonly string[]) => `${ids.join(", ")} ${ids.length === 1 ? "does" : "do"}`;

/** What a draft adds, as canonical skill names (a skill: its text; an experience line: its requirement). */
export function derivedKeys(d: Pick<DerivedDraft, "type" | "text" | "requirement">, table?: Pick<ImplicationTable, "terms">): string[] {
  const base = d.type === "skill" ? d.text : d.requirement;
  const terms = termsIn(base, table);
  return (terms.length > 0 ? terms : [base]).map(fold);
}

/**
 * The deterministic screen (§5.6, SEC-15, SEC-16, REQ-15.AC-2, REQ-27, REQ-28). Pure. Accepted
 * drafts keep their order; each rejected one lists every reason.
 */
export function screenDerivedFacts(drafts: readonly DeriveCandidate[], ctx: DeriveScreenContext): { accepted: DeriveCandidate[]; rejected: RejectedDerivedDraft[] } {
  const limit = ctx.limit ?? DERIVE_MAX_FACTS;
  const byId = new Map(ctx.cv.facts.map((f) => [f.id, f]));
  const active = activeFacts(ctx.cv);
  const allOrgs = [...new Set(ctx.cv.facts.map((f) => f.org).filter((o): o is string => !!o))];
  const accepted: DeriveCandidate[] = [];
  const acceptedKeys = new Set<string>();
  const rejected: RejectedDerivedDraft[] = [];
  for (const d of drafts) {
    const reasons: string[] = [];
    const note = (r: string) => {
      if (!reasons.includes(r)) reasons.push(r);
    };
    const ids = [...new Set(d.restsOn.map((r) => r.factId))];
    // SEC-16: only Ba's own facts, present in the current master CV.
    if (ids.length === 0) note("cites no fact");
    const cited: Fact[] = [];
    for (const id of ids) {
      const f = byId.get(id);
      if (!f) note(`cites ${id}, which is not in your master CV`);
      else if (isDerivedFact(f)) note(`cites ${id}, which was itself added automatically`);
      else cited.push(f);
    }
    if (cited.length > 0) {
      const citedIds = cited.map((f) => f.id);
      // The anchor: the model must point at Ba's own words.
      const inFact = (term: string, f: Fact) => termIn(term, f.text) || f.tags.some((t) => termIn(term, t));
      if (d.fromTerms.length === 0) note(`points at none of ${citedIds.join(", ")}'s words`);
      for (const term of d.fromTerms) if (!cited.some((f) => inFact(term, f))) note(`“${term}” is not in ${citedIds.join(", ")}`);
      for (const f of cited) if (d.fromTerms.length > 0 && !d.fromTerms.some((t) => inFact(t, f))) note(`${f.id} has none of the words it rests on`);
      // Categories: "Kubernetes implied from Java" (SEC-16.AC-4).
      const wanted = new Set([...categoriesOf(d.requirement, ctx.table), ...(d.type === "skill" ? categoriesOf(d.text, ctx.table) : [])]);
      for (const term of d.fromTerms) {
        const from = categoriesOf(term, ctx.table);
        if (wanted.size > 0 && from.size > 0 && ![...from].some((c) => wanted.has(c))) note(`${d.type === "skill" ? d.text : d.requirement} does not follow from ${term}`);
      }
      // Between two terms the table knows, the table decides (Kubernetes is not implied by Docker).
      const asked = [...new Set([...termsIn(d.requirement, ctx.table), ...(d.type === "skill" ? termsIn(d.text, ctx.table) : [])])];
      for (const term of d.fromTerms) {
        for (const by of termsIn(term, ctx.table)) {
          const linked = asked.some((t) => t === by || ctx.table.implications.some((i) => i.skill === t && i.impliedBy.includes(by)));
          if (asked.length > 0 && !linked) note(`the implication table does not take ${asked.join(", ")} from ${by}`);
        }
      }
      // Numbers, years, months, durations and titles (SEC-15, REQ-27, REQ-28).
      const source = { texts: cited.flatMap((f) => [f.text, f.textVi ?? "", ...f.tags]), dates: cited.map((f) => f.dates ?? "") };
      for (const field of [d.text, d.textVi ?? "", ...d.tags]) {
        for (const p of unsupportedClaims(field, source)) note(`${describeClaim(p)}, which ${plural(citedIds)} not say`);
      }
      // Names: a tool, product or employer that is neither the requirement, in the cited facts,
      // nor a skill the table says the cited facts imply.
      const implied = ctx.table.implications.filter((i) => i.impliedBy.some((by) => cited.some((f) => factNames(f, by, ctx.table))));
      const citedText = cited.map((f) => [f.text, f.org ?? "", ...f.tags].join(" ")).join("\n");
      for (const field of [d.text, d.textVi ?? ""]) {
        for (const name of capitalisedNames(field)) {
          if (titlesIn(name).length > 0) continue;
          const known = termIn(name, d.requirement) || termIn(name, citedText) || implied.some((i) => termIn(name, i.skill));
          if (!known) note(`names “${name}”, which ${plural(citedIds)} not`);
        }
      }
      const citedOrgs = new Set(cited.map((f) => f.org).filter((o): o is string => !!o).map(fold));
      for (const org of allOrgs) if (!citedOrgs.has(fold(org)) && [d.text, d.textVi ?? ""].some((t) => termIn(org, t))) note(`names the employer ${org}, which ${plural(citedIds)} not`);
      for (const name of ctx.forbiddenNames ?? []) if (name.trim() && [d.text, d.textVi ?? ""].some((t) => termIn(name, t))) note(`names ${name}, the job's company`);
    }
    // Already covered, denied, or over the cap.
    const keys = derivedKeys(d, ctx.table);
    if (keys.some((k) => ctx.table.denied.has(k))) note("you removed this fact before, so it is not added again");
    if (keys.some((k) => acceptedKeys.has(k)) || analyseGap(d.type === "skill" ? d.text : d.requirement, active, ctx.table).covered) note("your facts already cover it");
    if (reasons.length === 0 && accepted.length >= limit) note(`more than ${limit} facts for one job`);
    if (reasons.length > 0) rejected.push({ requirement: d.requirement, text: d.text, restsOn: ids, reasons, via: d.via });
    else {
      accepted.push(d);
      for (const k of keys) acceptedKeys.add(k);
    }
  }
  return { accepted, rejected };
}

/** The table pass's derivations as drafts (text = the skill name; relation implied_from). */
export function tableDrafts(derivations: readonly TableDerivation[]): DeriveCandidate[] {
  return derivations.map((d) => ({
    requirement: d.gap,
    type: "skill",
    text: d.implication.skill,
    textVi: d.implication.skill,
    tags: [d.implication.skill.toLowerCase()],
    restsOn: d.facts.map((f) => ({ factId: f.factId, relation: "implied_from" as DerivedRelation })),
    fromTerms: [...new Set(d.facts.map((f) => f.fromTerm))],
    rationale: d.implication.rationale,
    via: "table",
  }));
}

// ---------------------------------------------------------------- building the facts

interface DateRange {
  start: string;
  end: string;
  from: number;
  to: number;
}

const DATE_SPLIT = /\s*[–—-]\s*|\s+to\s+|\s+đến\s+/i;

function rangeOf(dates: string): DateRange | null {
  const parts = dates.split(DATE_SPLIT).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return null;
  const key = (p: string): number | null => {
    const c = claimsIn(p);
    if (c.present) return 999_912;
    const month = c.months.find((m) => !m.startsWith("*"));
    if (month) return Number(month.slice(0, 4)) * 100 + Number(month.slice(5));
    const year = c.numbers.find((n) => /^\d{4}$/.test(n));
    return year ? Number(year) * 100 : null;
  };
  const start = parts[0]!;
  const end = parts.at(-1)!;
  const from = key(start);
  const to = key(end);
  return from === null || to === null ? null : { start, end, from, to: end === start ? from : to };
}

/**
 * §5.1: org and dates of a derived fact, by code. One org shared by every cited fact → that org;
 * its dates are the shared dates, or the span from the earliest to the latest. Otherwise null.
 */
export function derivedOrgAndDates(cited: readonly Pick<Fact, "org" | "dates">[]): { org: string | null; dates: string | null } {
  const orgs = new Set(cited.map((f) => f.org ?? ""));
  if (orgs.size !== 1 || !cited[0]?.org) return { org: null, dates: null };
  const org = cited[0].org;
  const dates = [...new Set(cited.map((f) => f.dates?.trim() ?? ""))];
  if (dates.length === 1) return { org, dates: dates[0] || null };
  if (dates.includes("")) return { org, dates: null };
  const ranges = dates.map(rangeOf);
  if (ranges.some((r) => r === null)) return { org, dates: null };
  const rs = ranges as DateRange[];
  const first = rs.reduce((a, b) => (b.from < a.from ? b : a));
  const last = rs.reduce((a, b) => (b.to > a.to ? b : a));
  return { org, dates: first.start === last.end ? first.start : `${first.start} – ${last.end}` };
}

/** `<prefix of the first cited fact>-d<n>`, unique (grad-3 → grad-d1). */
export function derivedFactId(firstCitedId: string, used: Iterable<string>): string {
  const prefix = firstCitedId.split("-")[0] || "fact";
  const taken = new Set(used);
  let n = 1;
  for (const id of taken) {
    const m = new RegExp(`^${prefix}-d(\\d+)$`).exec(id);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  while (taken.has(`${prefix}-d${n}`)) n++;
  return `${prefix}-d${n}`;
}

export interface DerivedFactMeta {
  jobId: string | null;
  /** The cv.derive task; null for the table pass. */
  taskId: string | null;
  now: Date;
}

/** Accepted drafts as master facts: org, dates and source hashes from the cited facts (§5.1). */
export function buildDerivedFacts(accepted: readonly DeriveCandidate[], cv: Pick<MasterCv, "facts">, meta: DerivedFactMeta): Fact[] {
  const used = new Set(cv.facts.map((f) => f.id));
  const out: Fact[] = [];
  for (const d of accepted) {
    const cited = d.restsOn.map((r) => ({ r, f: cv.facts.find((f) => f.id === r.factId)! }));
    const id = derivedFactId(cited[0]!.f.id, used);
    used.add(id);
    const text = d.text.trim();
    out.push({
      id,
      type: d.type,
      text,
      textVi: d.textVi?.trim() || (d.type === "skill" ? text : null),
      tags: [...new Set([...(d.type === "skill" ? [text] : []), ...d.tags].map((t) => t.trim().toLowerCase()).filter(Boolean))],
      ...derivedOrgAndDates(cited.map((c) => c.f)),
      derived: {
        restsOn: cited.map(({ r, f }) => ({ factId: f.id, relation: r.relation, sourceHash: factSourceHash(f) })),
        via: d.via,
        rationale: d.rationale,
        requirement: d.requirement,
        jobId: meta.jobId,
        taskId: d.via === "model" ? meta.taskId : null,
        derivedAt: meta.now.toISOString(),
      },
    });
  }
  return out;
}

/** Model-judged implications that passed the screen, as learned allow entries (§5.3). */
export function learnedAllowFrom(accepted: readonly DeriveCandidate[], table: ImplicationTable, now: Date): LearnedImplications["allow"] {
  const out: LearnedImplications["allow"] = [];
  for (const d of accepted) {
    if (d.via !== "model" || d.type !== "skill" || !d.restsOn.some((r) => r.relation === "implied_from")) continue;
    const skill = termsIn(d.text, table)[0] ?? d.text.trim();
    for (const term of d.fromTerms) {
      const by = termsIn(term, table)[0] ?? term.trim();
      const known = table.implications.some((i) => fold(i.skill) === fold(skill) && i.impliedBy.some((b) => fold(b) === fold(by)));
      if (!known && !out.some((a) => fold(a.skill) === fold(skill) && fold(a.impliedBy) === fold(by))) {
        out.push({ skill, impliedBy: by, firstSeen: now.toISOString(), factId: d.restsOn[0]!.factId, rationale: d.rationale });
      }
    }
  }
  return out;
}

/** Deny entries for derived facts Ba undid or deleted (§5.3): never derived again. */
export function denyEntriesFor(facts: readonly Fact[], now: Date, table?: Pick<ImplicationTable, "terms">): LearnedImplications["deny"] {
  return facts
    .filter((f) => f.derived)
    .flatMap((f) =>
      derivedKeys({ type: f.type === "experience" ? "experience" : "skill", text: f.text, requirement: f.derived!.requirement }, table).map((skill) => ({
        skill,
        restsOn: f.derived!.restsOn.map((r) => r.factId),
        at: now.toISOString(),
      })),
    );
}
