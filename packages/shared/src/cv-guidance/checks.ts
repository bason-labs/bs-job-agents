// The deterministic guidance checkers (§5.6): run by code on every tailor round, at no cost. Each
// gives one item per rule it checks, in the same shape as cv.review's items. They never add
// content: a missing month or phone becomes a fact request to Ba, never a guess. Pure.
import { citedFactIds, type TailoredCv } from "../bots/cv.js";
import type { TaskFact } from "../domain/master-cv.js";
import { claimsIn } from "../truth/claims.js";
import type { ResolvedGuidance } from "./resolve.js";
import type { GuidanceCheck } from "./schema.js";

export const GUIDANCE_ITEM_STATUSES = ["met", "not_met", "needs_fact", "not_applicable"] as const;
export type GuidanceItemStatus = (typeof GUIDANCE_ITEM_STATUSES)[number];

/** Which fact detail a fact request asks for (§5.8). */
export type GuidanceFactField = "dates" | "result" | "contact.phone" | "detail";

export interface GuidanceFactRequestDraft {
  /** A master fact id, or "contact" for the contact block. */
  factId: string;
  field: GuidanceFactField;
  question: string;
}

/** One checker's or the reviewer's verdict on one rule. */
export interface GuidanceItem {
  ruleId: string;
  status: GuidanceItemStatus;
  reason: string;
  /** not_met only: a revision can fix it from Ba's facts. */
  fixable: boolean;
  fix: { instruction: string; factIds: string[] } | null;
  factRequests: GuidanceFactRequestDraft[];
}

export interface GuidanceCheckInput {
  cv: TailoredCv;
  pdfText: string;
  pageCount: number | null;
  /** Active facts of the task's master copy (Ba's and derived). */
  facts: readonly TaskFact[];
  contact: { name: string; email: string; phone: string | null; links: readonly string[] } | null;
}

const fold = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const short = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Every endpoint of a dates field has a month ("Present" counts as one). */
export function datesHaveMonths(dates: string | null): boolean {
  if (!dates) return false;
  const c = claimsIn(dates);
  const full = c.months.filter((m) => !m.startsWith("*")).length;
  const years = c.numbers.filter((n) => /^\d{4}$/.test(n)).length;
  return full >= 1 && years - full === 0;
}

const item = (ruleId: string, status: GuidanceItem["status"], reason: string, extra: Partial<GuidanceItem> = {}): GuidanceItem => ({ ruleId, status, reason, fixable: false, fix: null, factRequests: [], ...extra });

function checkMonthYear(ruleId: string, input: GuidanceCheckInput): GuidanceItem {
  const byId = new Map(input.facts.map((f) => [f.id, f]));
  const requests: GuidanceItem["factRequests"] = [];
  const toShow: string[] = [];
  let items = 0;
  for (const section of input.cv.sections) {
    if (section.kind !== "experience" && section.kind !== "education") continue;
    for (const it of section.items) {
      const cited = [...new Set(it.bullets.flatMap((b) => b.factIds))].map((id) => byId.get(id)).filter((f): f is TaskFact => f !== undefined && f.dates !== null);
      if (cited.length === 0) continue;
      items++;
      const withMonths = cited.find((f) => datesHaveMonths(f.dates));
      if (!withMonths) {
        const f = cited.find((x) => x.type === "experience" || x.type === "education") ?? cited[0]!;
        if (!requests.some((r) => r.factId === f.id)) {
          requests.push({ factId: f.id, field: "dates", question: `What were the start and end months of "${short(f.text)}" (${f.dates})?` });
        }
        continue;
      }
      // The facts have months: the CV item shows them (its dates line or the PDF text).
      const shown = claimsIn(`${it.subheading ?? ""} ${it.heading ?? ""}`).months.some((m) => !m.startsWith("*"));
      if (!shown) toShow.push(`${it.heading ?? section.title}: ${withMonths.dates} (${withMonths.id})`);
    }
  }
  if (items === 0) return item(ruleId, "met", "No dated experience or education item on this CV.");
  if (requests.length > 0) {
    return item(ruleId, "needs_fact", `${requests.length} ${requests.length === 1 ? "fact gives" : "facts give"} only years; the CV keeps the years until you add the months.`, { factRequests: requests });
  }
  if (toShow.length > 0) {
    return item(ruleId, "not_met", "The facts give month and year, but the CV shows only years.", {
      fixable: true,
      fix: { instruction: `Show month and year exactly as the facts give them: ${toShow.join("; ")}.`, factIds: toShow.map((t) => /\(([^)]+)\)$/.exec(t)?.[1] ?? "").filter(Boolean) },
    });
  }
  return item(ruleId, "met", "Every dated item shows month and year.");
}

const digits = (s: string) => s.replace(/\D/g, "");

function checkContact(ruleId: string, input: GuidanceCheckInput): GuidanceItem {
  const c = input.contact;
  if (!c) return item(ruleId, "not_met", "The master CV has no contact block to check.");
  if (!c.phone) {
    return item(ruleId, "needs_fact", "Your master CV has no phone number.", {
      factRequests: [{ factId: "contact", field: "contact.phone", question: "What phone number should your CVs show?" }],
    });
  }
  const text = fold(input.pdfText);
  const missing: string[] = [];
  if (!text.includes(fold(c.name))) missing.push("name");
  if (!text.includes(c.email.toLowerCase())) missing.push("email");
  const phone = digits(c.phone).slice(-9);
  const runs = [...input.pdfText.matchAll(/[+\d][\d\s().-]{6,}\d/g)].map((m) => digits(m[0]));
  if (phone.length < 6 || !runs.some((r) => r.endsWith(phone))) missing.push("phone");
  if (missing.length === 0) return item(ruleId, "met", "Name, phone and email are on the CV.");
  return item(ruleId, "not_met", `The CV's text lacks the ${missing.join(", ")} from your master CV.`, {
    fixable: true,
    fix: { instruction: `Show the ${missing.join(", ")} in the contact line exactly as the master CV has them.`, factIds: [] },
  });
}

const linkKey = (url: string): string =>
  url
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");

function checkLinks(ruleId: string, input: GuidanceCheckInput): GuidanceItem {
  const links = input.contact?.links ?? [];
  if (links.length === 0) return item(ruleId, "not_applicable", "Your master CV has no profile link.");
  const text = input.pdfText.toLowerCase().replace(/\s+/g, "");
  if (links.some((l) => text.includes(linkKey(l)))) return item(ruleId, "met", "A profile link is on the CV.");
  return item(ruleId, "not_met", "None of your profile links is on the CV.", {
    fixable: true,
    fix: { instruction: `Show your link ${linkKey(links[0]!)} in the contact line.`, factIds: [] },
  });
}

/** The technologies a skills section lists ("Frontend: React, Next.js" → React, Next.js). */
export function listedSkills(cv: TailoredCv): string[] {
  const out: string[] = [];
  for (const s of cv.sections) {
    if (s.kind !== "skills") continue;
    for (const it of s.items) {
      for (const b of it.bullets) {
        const body = b.text.replace(/^[^:]{1,30}:\s*/, "");
        for (const raw of body.split(/[,;|•·\n]|\s+\/\s+|\s+(?:and|và)\s+/)) {
          const term = raw.replace(/\(.*?\)/g, "").replace(/[.\s]+$/, "").trim();
          if (term.length >= 1 && term.length <= 40 && !out.some((t) => fold(t) === fold(term))) out.push(term);
        }
      }
    }
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `term` appears in `text` as a word or phrase (case and diacritics folded; "Node.js" = "NodeJS"). */
export function mentions(text: string, term: string): boolean {
  const t = fold(term);
  const h = fold(text);
  if (t === "") return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}+#])${escape(t)}(?![\\p{L}\\p{N}+#])`, "u");
  if (re.test(h)) return true;
  const squash = (s: string) => s.replace(/[.\-\s]/g, "");
  const tokens = h.split(/[^\p{L}\p{N}+#.-]+/u).map(squash);
  return squash(t).length >= 3 && tokens.includes(squash(t));
}

function checkPracticalExperience(ruleId: string, input: GuidanceCheckInput): GuidanceItem {
  const skills = listedSkills(input.cv);
  if (skills.length === 0) return item(ruleId, "met", "The CV lists no skills section.");
  const work = input.facts.filter((f) => f.type === "experience" || f.type === "project");
  const workIds = new Set(work.map((f) => f.id));
  // A derived fact resting on an experience or project fact counts as practice (CV auto-extend).
  const derived = input.facts.filter((f) => f.derived && (f.restsOn ?? []).some((id) => workIds.has(id)));
  const haystacks = [...work, ...derived].map((f) => [f.text, f.textVi ?? "", ...f.tags].join(" \n "));
  const unsupported = skills.filter((s) => !haystacks.some((h) => mentions(h, s)));
  if (unsupported.length === 0) return item(ruleId, "met", "Every listed technology appears in an experience or project fact.");
  const names = unsupported.join(", ");
  return item(ruleId, "not_met", `No experience or project fact mentions ${names}.`, {
    fixable: true,
    fix: { instruction: `Remove ${names} from the skills section: no experience or project fact shows practice with ${unsupported.length === 1 ? "it" : "them"}.`, factIds: [] },
  });
}

function checkPageLength(ruleId: string, input: GuidanceCheckInput): GuidanceItem {
  const n = input.pageCount;
  return item(ruleId, n === null ? "not_applicable" : "met", n === null ? "The page count is unknown." : `The PDF has ${n} page${n === 1 ? "" : "s"}.`);
}

const CHECKERS: Record<Exclude<GuidanceCheck, "judgement">, (ruleId: string, input: GuidanceCheckInput) => GuidanceItem> = {
  month_year: checkMonthYear,
  contact_present: checkContact,
  links_present: checkLinks,
  practical_experience: checkPracticalExperience,
  page_length: checkPageLength,
};

/**
 * Run the deterministic checker of every rule that has one, except rules Ba turned off and rules
 * that do not apply (overridden rules still record what was measured, e.g. the page count).
 */
export function runGuidanceChecks(resolved: ResolvedGuidance, input: GuidanceCheckInput): GuidanceItem[] {
  const out: GuidanceItem[] = [];
  for (const r of resolved.rules) {
    if (r.check === "judgement") continue;
    if (r.disposition === "turned_off" || r.disposition === "not_applicable" || r.disposition === "disputed_not_applied") continue;
    out.push(CHECKERS[r.check](r.ruleId, input));
  }
  return out;
}

/** The facts a review may use: active facts the CV cites, plus the contact block id. */
export function citedActiveFactIds(cv: TailoredCv, facts: readonly TaskFact[]): string[] {
  const active = new Set(facts.map((f) => f.id));
  return citedFactIds(cv).filter((id) => active.has(id));
}
