// The search profile's filters for feed postings (W5). Feeds return a board's latest postings; this
// keeps the ones that fit Ba's criteria, in code, before anything reaches the fit step (an LLM).
//   roles             the title (or the board's tags) has a role's words: "Frontend Engineer" →
//                     "frontend"; generic words (engineer, developer, software…) only need any dev
//                     title; "(React/Node)" asks for one of those words anywhere in the posting
//   includeKeywords   at least one of them in the title, tags or JD (when any are set)
//   excludeKeywords   none of them in the title or tags
//   excludeCompanies  not one of these companies
//   seniority         a title that names a level (Senior, Junior, Lead/Staff/Principal, Intern) must
//                     name a wanted one; a title without a level is kept
//   timezoneOverlap   the posting's stated region overlaps it (regions.ts)
//   minSalary         REMOTE_SALARY_RULE (shared): USD only, per month, the top of the range
// The city filter and work modes are ignored: these boards list remote jobs only.
import { parseTimezoneOverlap, type SearchProfileFieldsBase, type Seniority } from "@bs-job-agents/shared";
import { parseSalary } from "../salary.js";
import { foldText } from "../text.js";
import { regionFits } from "./regions.js";
import type { FeedPosting } from "./types.js";

/** Words that say "a developer" but not which kind. */
const GENERIC = new Set(["engineer", "engineering", "developer", "development", "dev", "programmer", "software", "web", "specialist", "remote", "i", "ii", "iii", "iv"]);
const LEVEL_WORDS = new Set(["intern", "internship", "junior", "jr", "mid", "middle", "senior", "sr", "lead", "principal", "staff", "head"]);
const DEV_TITLE = /\b(engineer|developer|programmer|dev|architect|sre|devops)\b/;

/** Folded text with the boards' spelling variants unified (front-end → frontend, React.js → react). */
export function normaliseTerms(text: string | null | undefined): string {
  return ` ${foldText(text)
    .replace(/\bfront[\s-]?end\b/g, "frontend")
    .replace(/\bback[\s-]?end\b/g, "backend")
    .replace(/\bfull[\s-]?stack\b/g, "fullstack")
    .replace(/\b(react|vue|next|node|nest|nuxt|angular|ember)[\s.-]?js\b/g, "$1")
    .replace(/\.net\b/g, " dotnet")
    .replace(/\bc#/g, "csharp")
    .replace(/\bgolang\b/g, "go")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim()} `;
}

const has = (haystack: string, word: string): boolean => haystack.includes(` ${word} `);

interface RoleTerms {
  core: string[];
  /** From "(React/Node)": any one of them. */
  stack: string[];
}

function roleTerms(role: string): RoleTerms {
  const stack = [...role.matchAll(/\(([^)]*)\)/g)].flatMap((m) => normaliseTerms(m[1]!.replace(/[/,|]/g, " ")).trim().split(" ")).filter(Boolean);
  const core = normaliseTerms(role.replace(/\([^)]*\)/g, " "))
    .trim()
    .split(" ")
    .filter((w) => w && !GENERIC.has(w) && !LEVEL_WORDS.has(w));
  return { core, stack };
}

function roleMatches(p: FilterablePosting, roles: readonly string[]): boolean {
  if (roles.length === 0) return true;
  const title = normaliseTerms(p.title);
  const titleAndTags = `${title}${normaliseTerms(p.tags.join(" , "))}`;
  const everything = `${titleAndTags}${normaliseTerms(p.jdText)}`;
  return roles.some((role) => {
    const { core, stack } = roleTerms(role);
    const coreOk = core.length > 0 ? core.every((w) => has(titleAndTags, w)) : DEV_TITLE.test(title);
    const stackOk = stack.length === 0 || stack.some((w) => has(everything, w));
    return coreOk && stackOk;
  });
}

/** The level a title names, or null. */
export function titleLevel(title: string): Seniority | null {
  const t = normaliseTerms(title);
  if (/ (intern|internship|trainee) /.test(t)) return "intern";
  if (/ (lead|principal|staff|head of|director|vp) /.test(t)) return "lead";
  if (/ (senior|sr) /.test(t)) return "senior";
  if (/ (junior|jr|entry level|graduate) /.test(t)) return "junior";
  if (/ (mid|middle|intermediate) /.test(t)) return "mid";
  return null;
}

const HOURS_PER_MONTH = 160;

/** The top of a posting's USD salary, per month; null when there is no USD amount to compare. */
export function monthlyUsdTop(salaryText: string | null): number | null {
  if (!salaryText) return null;
  const t = foldText(salaryText);
  if (/€|£|\beur\b|\bgbp\b|\bcad\b|\baud\b|\binr\b/.test(t)) return null;
  const s = parseSalary(salaryText);
  if (!s || s.currency !== "USD") return null;
  const top = s.max ?? s.min;
  if (top === null) return null;
  if (/\/\s*h(ou)?r\b|per hour|hourly|an hour|\/h\b/.test(t)) return top * HOURS_PER_MONTH;
  if (/\/\s*mo(nth)?\b|per month|monthly|a month/.test(t)) return top;
  if (/\/\s*y(ea)?r\b|per year|yearly|annual|a year|per annum/.test(t) || top >= 10_000) return Math.round(top / 12);
  return null;
}

export type DropReason = "role" | "include" | "exclude" | "company" | "seniority" | "region" | "salary" | "snippet";

/** What the filters read of a posting (feeds, and the board-API mappers in ../board-api). */
export type FilterablePosting = Pick<FeedPosting, "title" | "company" | "regionText" | "salaryText" | "tags" | "jdText">;

export interface FilterResult<P extends FilterablePosting = FeedPosting> {
  kept: P[];
  dropped: { posting: P; reason: DropReason }[];
}

/** A JD shorter than this is a teaser, not the full text (same bar as Research's self-check). */
export const FEED_MIN_JD_CHARS = 150;

export function filterPostings<P extends FilterablePosting>(postings: readonly P[], criteria: SearchProfileFieldsBase): FilterResult<P> {
  const overlap = parseTimezoneOverlap(criteria.timezoneOverlap ?? null);
  const include = criteria.includeKeywords.map((k) => normaliseTerms(k).trim()).filter(Boolean);
  const exclude = criteria.excludeKeywords.map((k) => normaliseTerms(k).trim()).filter(Boolean);
  const companies = criteria.excludeCompanies.map((c) => foldText(c)).filter(Boolean);
  const wantedLevels = new Set(criteria.seniority);
  const floor = criteria.minSalary !== null && criteria.currency === "USD" ? criteria.minSalary : null;
  const result: FilterResult<P> = { kept: [], dropped: [] };
  for (const p of postings) {
    const titleAndTags = `${normaliseTerms(p.title)}${normaliseTerms(p.tags.join(" , "))}`;
    const reason = ((): DropReason | null => {
      if (p.jdText.length < FEED_MIN_JD_CHARS) return "snippet";
      if (companies.some((c) => foldText(p.company) === c || foldText(p.company).includes(c))) return "company";
      if (!roleMatches(p, criteria.roles)) return "role";
      if (include.length > 0 && !include.some((k) => `${titleAndTags}${normaliseTerms(p.jdText)}`.includes(` ${k} `))) return "include";
      if (exclude.some((k) => titleAndTags.includes(` ${k} `))) return "exclude";
      const level = titleLevel(p.title);
      if (level && wantedLevels.size > 0 && !wantedLevels.has(level)) return "seniority";
      if (!regionFits(p.regionText, overlap)) return "region";
      if (floor !== null) {
        const top = monthlyUsdTop(p.salaryText);
        if (top !== null && top < floor) return "salary";
      }
      return null;
    })();
    if (reason) result.dropped.push({ posting: p, reason });
    else result.kept.push(p);
  }
  return result;
}
