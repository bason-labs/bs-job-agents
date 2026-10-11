// Read a listing or job page of a source and tell a good read from a block (login wall, CAPTCHA)
// and from a broken adapter (the layout no longer matches the selectors). W4a, UC-03 a/b/d, §12.
import type { WorkMode } from "@bs-job-agents/shared";
import { canonicalJobUrl } from "./canonical-url.js";
import { parsePostedDate } from "./posted-date.js";
import { careerSiteParser } from "./parsers/career-site.js";
import { pageTitle, type DomRoot } from "./parsers/dom.js";
import { itviecParser } from "./parsers/itviec.js";
import { linkedinParser } from "./parsers/linkedin.js";
import { topcvParser } from "./parsers/topcv.js";
import { upworkParser } from "./parsers/upwork.js";
import { vietnamworksParser } from "./parsers/vietnamworks.js";
import { wellfoundParser } from "./parsers/wellfound.js";
import type { SourceParser } from "./parsers/types.js";
import { cleanText, detectLanguage, foldText } from "./text.js";

export type ParsedSource = "topcv" | "itviec" | "linkedin" | "career_site" | "vietnamworks" | "wellfound" | "upwork";

export const PARSERS: Record<ParsedSource, SourceParser> = {
  topcv: topcvParser,
  itviec: itviecParser,
  linkedin: linkedinParser,
  career_site: careerSiteParser,
  vietnamworks: vietnamworksParser,
  wellfound: wellfoundParser,
  upwork: upworkParser,
};

/** A job description shorter than this is a snippet, not the full JD (Research's self-check). */
export const MIN_JD_CHARS = 150;

export interface ListingCard {
  /** Canonical posting URL. */
  url: string;
  title: string;
  company: string | null;
  location: string | null;
  salaryText: string | null;
  postedText: string | null;
  postedAt: string | null;
  workMode: WorkMode | null;
}

export interface JobPage {
  url: string | null;
  title: string;
  company: string | null;
  location: string | null;
  salaryText: string | null;
  postedText: string | null;
  postedAt: string | null;
  workMode: WorkMode | null;
  jdText: string;
  language: "vi" | "en";
}

export type Blocked = { status: "blocked"; reason: "needs_login" | "captcha"; detail: string };
export type Broken = { status: "broken"; reason: string };
export type ListingRead = { status: "ok"; page: { cards: ListingCard[]; resultCount: number | null } } | Blocked | Broken;
export type JobRead = { status: "ok"; job: JobPage } | Blocked | Broken;

export function workModeOf(text: string | null | undefined): WorkMode | null {
  const t = foldText(text);
  if (!t) return null;
  if (/\bhybrid\b|ket hop|linh hoat/.test(t)) return "hybrid";
  if (/\bremote\b|tu xa|work from home/.test(t)) return "remote";
  if (/at office|on-?site|tai van phong|in office/.test(t)) return "onsite";
  return null;
}

/** A login wall or a bot check instead of the page we asked for (UC-03 a, UC-17). */
export function detectBlock(root: DomRoot): Blocked | null {
  const title = foldText(pageTitle(root));
  const canonical = root.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? "";
  const body = foldText(root.querySelector("body")?.textContent ?? "").slice(0, 4000);
  if (
    /\/(authwall|login|checkpoint|uas\/login)\b/.test(canonical) ||
    root.querySelector(".authwall, .authwall-join-form, form.login__form") ||
    /^(sign up|sign in|log in|dang nhap)\b/.test(title)
  ) {
    return { status: "blocked", reason: "needs_login", detail: "the site shows its sign-in wall instead of the page" };
  }
  if (
    root.querySelector("#challenge-form, .cf-challenge, iframe[src*='captcha'], .g-recaptcha, #captcha, .h-captcha") ||
    /just a moment|attention required|verify you are human|security check|captcha|^challenge\b/.test(title) ||
    /verify you are human|xac minh ban khong phai la robot/.test(body)
  ) {
    return { status: "blocked", reason: "captcha", detail: "the site shows a CAPTCHA / bot check" };
  }
  return null;
}

/** The page states that the search found nothing ("0 việc làm", "Không tìm thấy", "No jobs found"). */
function saysNoResults(root: DomRoot, count: number | null): boolean {
  if (count === 0) return true;
  const body = foldText(root.querySelector("body")?.textContent ?? "");
  return /khong tim thay|chua co viec lam|no (matching )?jobs? found|no results|we couldn'?t find/.test(body);
}

export function readListingPage(source: ParsedSource, root: DomRoot, pageUrl: string, now: Date = new Date()): ListingRead {
  const blocked = detectBlock(root);
  if (blocked) return blocked;
  const parser = PARSERS[source];
  const count = parser.resultCount(root);
  const raw = parser.cards(root);

  if (raw.length === 0) {
    if (saysNoResults(root, count)) return { status: "ok", page: { cards: [], resultCount: count ?? 0 } };
    return {
      status: "broken",
      reason:
        count !== null
          ? `the results page says ${count} jobs but no job cards were found (looked for ${parser.cardSelector})`
          : `no job cards and no result count on the results page (looked for ${parser.cardSelector})`,
    };
  }

  const cards: ListingCard[] = [];
  for (const c of raw) {
    const url = c.href ? canonicalJobUrl(new URL(c.href, pageUrl).toString()) : null;
    const title = cleanText(c.title);
    if (!url || !title) continue;
    cards.push({
      url,
      title,
      company: c.company,
      location: c.location,
      salaryText: c.salaryText,
      postedText: c.postedText,
      postedAt: parsePostedDate(c.postedDate, now) ?? parsePostedDate(c.postedText, now),
      workMode: workModeOf(c.workModeText),
    });
  }
  if (cards.length === 0) {
    return { status: "broken", reason: `found ${raw.length} job cards but none had a title and a posting link (${parser.cardSelector})` };
  }
  return { status: "ok", page: { cards, resultCount: count } };
}

export function readJobPage(source: ParsedSource, root: DomRoot, pageUrl: string, now: Date = new Date()): JobRead {
  const blocked = detectBlock(root);
  if (blocked) return blocked;
  const parser = PARSERS[source];
  const raw = parser.job(root);
  const title = cleanText(raw.title);
  if (!title) return { status: "broken", reason: "no job title on the job page (looked for h1)" };
  const jdText = raw.jdText ?? "";
  if (jdText.length < MIN_JD_CHARS) {
    return { status: "broken", reason: `the JD block is missing or only ${jdText.length} characters (looked for ${parser.jdSelector})` };
  }
  const canonicalSource = raw.canonicalHref ? new URL(raw.canonicalHref, pageUrl).toString() : pageUrl;
  return {
    status: "ok",
    job: {
      url: canonicalJobUrl(canonicalSource) ?? canonicalJobUrl(pageUrl),
      title,
      company: raw.company,
      location: raw.location,
      salaryText: raw.salaryText,
      postedText: raw.postedText,
      postedAt: parsePostedDate(raw.postedDate, now) ?? parsePostedDate(raw.postedText, now),
      workMode: workModeOf(raw.workModeText),
      jdText,
      language: detectLanguage(jdText),
    },
  };
}

