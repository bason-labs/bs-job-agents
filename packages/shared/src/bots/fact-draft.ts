// cv.fact_draft (owner request 2026-10-11): on the Master CV screen Ba answers CV's fact request
// ("Have you deployed on AWS?"), or tells something new, in his own words (EN or VI). CV turns only
// what he wrote into master facts; the orchestrator checks them (schema, ids, the invented-detail
// guard below) and adds them as a new master version that Ba can undo (§6.1: Ba-owned data).
import { z } from "zod";
import { FACT_ID_PATTERN, FactTypeSchema, type Fact } from "../domain/master-cv.js";
import { botEnvelopeShape } from "./self-check.js";

/** At most this many facts per answer. */
export const FACT_DRAFT_MAX_FACTS = 5;
/** Ba's text, in characters. */
export const FACT_DRAFT_TEXT_MAX = 4000;

/** CV's self-check for cv.fact_draft (bots/cv/bot.json selfCheckByKind.fact_draft). */
export const FACT_DRAFT_SELF_CHECK = [
  "Every claim in the facts appears in Ba's text",
  "No number, tool, employer, title or date Ba did not give",
  "Each fact has English text and a faithful Vietnamese translation",
  "Fact ids are new lowercase slugs that no existing fact uses",
] as const;

/** A master fact as CV drafts it (strict: every field present, null where there is nothing). */
export const DraftedFactSchema = z.strictObject({
  id: z
    .string()
    .regex(FACT_ID_PATTERN, "fact ids are lowercase slugs such as grad-5")
    .describe("New lowercase slug id, shaped like the existing ids (e.g. grad-5, skill-3) and used by no existing fact"),
  type: FactTypeSchema,
  text: z.string().min(1).describe("English wording, only what Ba wrote (translated faithfully when he wrote Vietnamese)"),
  textVi: z.string().min(1).nullable().describe("Vietnamese wording, a faithful translation (or Ba's own Vietnamese)"),
  tags: z.array(z.string().min(1)).describe("Short lowercase tags taken from Ba's text, e.g. aws, docker"),
  org: z.string().min(1).nullable().describe("Organisation: one Ba named, or an existing fact's org he refers to; else null"),
  dates: z.string().min(1).nullable().describe("Dates Ba gave, or the existing fact's dates when he refers to that role; else null"),
});
export type DraftedFact = z.infer<typeof DraftedFactSchema>;

export const FactDraftOutputSchema = z.strictObject({
  facts: z
    .array(DraftedFactSchema)
    .max(FACT_DRAFT_MAX_FACTS)
    .describe("1–5 facts from Ba's text; empty when his text says no or gives nothing to add"),
  notes: z
    .string()
    .min(1)
    .nullable()
    .describe("A short note for Ba: why there is no fact, or which detail you left out because he did not give it; null if none"),
  ...botEnvelopeShape,
});
export type FactDraftOutput = z.infer<typeof FactDraftOutputSchema>;

// ---------------------------------------------------------------- invented-detail guard

/** What the guard compares a drafted fact with: Ba's words, the question he answered, and his existing facts. */
export interface FactDraftSource {
  text: string;
  question?: { topic: string; question: string } | null;
  existingFacts: ReadonlyArray<Pick<Fact, "id" | "org" | "dates">>;
}

export interface RejectedDraftFact {
  id: string;
  text: string;
  reasons: string[];
}

const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  twelve: "12", twenty: "20", hundred: "100", thousand: "1000",
  // Not "năm": it also means "year".
  "một": "1", hai: "2", ba: "3", "bốn": "4", "sáu": "6", "bảy": "7", "tám": "8", "chín": "9", "mười": "10",
  "trăm": "100", "nghìn": "1000", "ngàn": "1000",
};

/** Month names a fact may spell out when Ba gave the month as a number (the year is still checked). */
const MONTHS = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

const lower = (s: string) => s.normalize("NFC").toLowerCase();

/** Numbers as digit strings ("1,000" and "1.000" → "1000", "40%" → "40"). */
function numbersIn(s: string): string[] {
  return [...s.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0].replace(/[.,]/g, "").replace(/^0+(?=\d)/, ""));
}

function allowedNumbers(corpus: string): Set<string> {
  const out = new Set(numbersIn(corpus));
  for (const word of lower(corpus).split(/[^\p{L}]+/u)) {
    const n = NUMBER_WORDS[word];
    if (n) out.add(n);
  }
  return out;
}

/**
 * Capitalised names in a text that look like tools, products or employers: a word with a capital
 * after its first letter or a digit among letters (GraphQL, AWS, K8s, EC2), or any capitalised word
 * that does not start a sentence. Only ASCII words count (Vietnamese words carry diacritics).
 */
export function capitalisedNames(text: string): string[] {
  const out: string[] = [];
  let sentenceStart = true;
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}+#.\-/]*|[.!?•\n]/gu)) {
    const raw = m[0];
    if (/^[.!?•\n]$/.test(raw)) {
      sentenceStart = true;
      continue;
    }
    const word = raw.replace(/[.\-/]+$/, "");
    const atStart = sentenceStart;
    sentenceStart = raw.endsWith(".");
    if (!/^[A-Za-z0-9+#.\-/]+$/.test(word) || !/[A-Z]/.test(word)) continue;
    if (MONTHS.has(word.toLowerCase()) || word === "I") continue;
    const inner = /[A-Z]/.test(word.slice(1)) || (/\d/.test(word) && /[A-Za-z]/.test(word));
    if (inner || !atStart) out.push(word);
  }
  return out;
}

/**
 * The invented-detail guard (owner request 2026-10-11): facts come only from Ba's text. A drafted
 * fact is rejected when its text (EN or VI) or tags carry a number Ba did not write, its text names
 * a capitalised tool or name that is in neither his words, the question he answered nor his
 * existing organisations, or its org/dates come from nowhere he gave. Deterministic and deliberately
 * simple; CV's own self-check covers the rest.
 */
export function screenDraftedFacts(facts: readonly DraftedFact[], source: FactDraftSource): { accepted: DraftedFact[]; rejected: RejectedDraftFact[] } {
  const corpus = [source.text, source.question?.topic ?? "", source.question?.question ?? ""].join("\n");
  const corpusLower = lower(corpus);
  const numbers = allowedNumbers(corpus);
  const orgs = new Set(source.existingFacts.map((f) => f.org).filter((o): o is string => !!o).map(lower));
  const datesKnown = new Set(source.existingFacts.map((f) => f.dates?.trim()).filter((d): d is string => !!d));
  const nameKnown = (name: string) => corpusLower.includes(lower(name)) || [...orgs].some((o) => o.includes(lower(name)));
  const accepted: DraftedFact[] = [];
  const rejected: RejectedDraftFact[] = [];
  for (const fact of facts) {
    const reasons: string[] = [];
    const seen = new Set<string>();
    const note = (r: string) => {
      if (!seen.has(r)) reasons.push(r);
      seen.add(r);
    };
    for (const field of [fact.text, fact.textVi ?? "", ...fact.tags]) {
      for (const n of numbersIn(field)) if (!numbers.has(n)) note(`the number ${n} is not in your words`);
    }
    for (const field of [fact.text, fact.textVi ?? ""]) {
      for (const name of capitalisedNames(field)) if (!nameKnown(name)) note(`“${name}” is not in your words`);
    }
    if (fact.org && !corpusLower.includes(lower(fact.org)) && !orgs.has(lower(fact.org))) note(`the organisation “${fact.org}” is not in your words or your facts`);
    if (fact.dates && !datesKnown.has(fact.dates.trim())) {
      for (const n of numbersIn(fact.dates)) if (!numbers.has(n)) note(`the date ${n} is not in your words`);
    }
    if (reasons.length > 0) rejected.push({ id: fact.id, text: fact.text, reasons });
    else accepted.push(fact);
  }
  return { accepted, rejected };
}

/**
 * Give drafted facts ids no other fact uses: an id already taken (by Ba's facts or an earlier draft
 * in the list) gets the next free number of its prefix, e.g. grad-4 → grad-6.
 */
export function withFreeFactIds<F extends { id: string }>(facts: readonly F[], existingIds: Iterable<string>): F[] {
  const used = new Set(existingIds);
  return facts.map((f) => {
    let id = f.id;
    if (used.has(id)) {
      const prefix = id.replace(/-\d+$/, "") || "fact";
      const taken = [...used]
        .map((u) => new RegExp(`^${prefix.replace(/[^a-z0-9-]/g, "")}-(\\d+)$`).exec(u))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1]));
      id = `${prefix}-${(taken.length ? Math.max(...taken) : 0) + 1}`;
    }
    used.add(id);
    return id === f.id ? f : { ...f, id };
  });
}

/** A drafted fact as a master fact. */
export function draftedToFact(f: DraftedFact): Fact {
  return { id: f.id, type: f.type, text: f.text.trim(), textVi: f.textVi?.trim() || null, tags: [...new Set(f.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))], org: f.org, dates: f.dates };
}
