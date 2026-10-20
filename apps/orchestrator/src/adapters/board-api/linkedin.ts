// LinkedIn (2026-10-20 addendum; records/linkedin.json): the logged-out jobs-guest pages only, read
// once Ba approved the high-risk record. No cookie is ever sent (the record's auth is "none", so the
// client adds none, and it refuses a Cookie header from a reader). LinkedIn rate-limits guests by
// IP, so the limits are fixed here and in the host gate:
//   1 search page per scan (start=0 only: the first role × location of the search profile),
//   at most LINKEDIN_MAX_JOB_PAGES job pages (and the scan's job limit),
//   at least 3000 ms between two requests to linkedin.com (adapters/http HOST_MIN_GAPS_MS).
// A 429, a 999 or a challenge page stops the scan at once with DirectReadBlocked and is never
// retried: the run reads LinkedIn in the browser this time ("LinkedIn blocked the direct read").
// The HTML fragments are read with the small parser in parsers/html.ts; recruiter, face-pile and
// sign-in blocks are never read (only the selectors below are).
import type { JobCandidate, ResearchScanInput } from "@bs-job-agents/shared";
import { FEED_MIN_JD_CHARS } from "../feeds/filter.js";
import { HOST_MIN_GAPS_MS } from "../http/index.js";
import { all, attrOf, blockText, textOf, type DomRoot } from "../parsers/dom.js";
import { parseHtml } from "../parsers/html.js";
import { parsePostedDate } from "../posted-date.js";
import { scanJobLimit, searchUrls } from "../sources.js";
import { cleanText, detectLanguage } from "../text.js";
import { ApiChanged, BoardApiError, DirectReadBlocked, RedirectRefused, isBotCheckPage, type BoardApiClient } from "./client.js";
import { excludedTerms, excludedTitle, finishBoardScan, plural } from "./json-ld-board.js";
import type { BoardMapper, BoardScanResult } from "./types.js";

export const LINKEDIN_HOST = "www.linkedin.com";
export const LINKEDIN_SEARCH_PATH = "/jobs-guest/jobs/api/seeMoreJobPostings/search";
export const linkedinDetailPath = (jobId: string) => `/jobs-guest/jobs/api/jobPosting/${jobId}`;
/** Search pages per scan: the first page (start=0) only. */
export const LINKEDIN_MAX_SEARCH_PAGES = 1;
/** Job pages per scan. */
export const LINKEDIN_MAX_JOB_PAGES = 10;
/** The gap the host gate keeps for linkedin.com (asserted by a test). */
export const LINKEDIN_MIN_GAP_MS = HOST_MIN_GAPS_MS["linkedin.com"]!;
/** HTTP answers that mean LinkedIn is limiting this IP: stop now, never retry. */
const BLOCK_STATUSES = new Set([429, 999]);

export interface LinkedinCard {
  jobId: string;
  /** https://www.linkedin.com/jobs/view/<id>/ */
  url: string;
  title: string | null;
  company: string | null;
  location: string | null;
  postedDate: string | null;
  salaryText: string | null;
}

/** The search query the scan sends: the first search of the profile (keywords, location, last 7 days), start 0. */
export function linkedinSearchQuery(criteria: ResearchScanInput["criteria"]): Record<string, string> | null {
  const first = searchUrls("linkedin", criteria)[0];
  if (!first) return null;
  const q = new URL(first).searchParams;
  return { keywords: q.get("keywords") ?? "", location: q.get("location") ?? "Vietnam", f_TPR: q.get("f_TPR") ?? "r604800", start: "0" };
}

/** A 200 page that is not LinkedIn's content: a bot check, the cookie challenge (a meta refresh) or the authwall. */
export function isLinkedinChallenge(html: string): boolean {
  const head = html.slice(0, 50_000);
  return (
    isBotCheckPage(head) ||
    /<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(head) ||
    /<link[^>]+rel\s*=\s*["']?canonical["']?[^>]+\/authwall/i.test(head) ||
    /<body[^>]*class\s*=\s*["'][^"']*\bauthwall\b/i.test(head)
  );
}

const urnId = (urn: string | null): string | null => /^urn:li:jobPosting:(\d+)$/.exec(urn ?? "")?.[1] ?? null;

/** The job cards of a search fragment. */
export function linkedinCards(root: DomRoot): LinkedinCard[] {
  const cards: LinkedinCard[] = [];
  const seen = new Set<string>();
  for (const card of all(root, "div.base-card[data-entity-urn]")) {
    const jobId = urnId(card.getAttribute("data-entity-urn"));
    if (!jobId || seen.has(jobId)) continue;
    seen.add(jobId);
    cards.push({
      jobId,
      url: `https://www.linkedin.com/jobs/view/${jobId}/`,
      title: textOf(card, "h3.base-search-card__title"),
      company: textOf(card, "h4.base-search-card__subtitle a.hidden-nested-link") ?? textOf(card, "h4.base-search-card__subtitle"),
      location: textOf(card, "span.job-search-card__location"),
      postedDate: attrOf(card, "time.job-search-card__listdate, time.job-search-card__listdate--new", "datetime"),
      salaryText: textOf(card, "span.job-search-card__salary-info"),
    });
  }
  return cards;
}

/** A guest job page as a JobCandidate (the card fills what it lacks), or "incomplete". */
export function linkedinJob(card: LinkedinCard, html: string): JobCandidate | "incomplete" {
  const root = parseHtml(html);
  // The page names its posting; another posting's page is not this card's.
  const pageId = /<code[^>]+id\s*=\s*["']decoratedJobPostingId["'][^>]*>\s*<!--\s*"?(\d+)"?\s*-->/.exec(html)?.[1];
  if (pageId !== undefined && pageId !== card.jobId) return "incomplete";
  const markup = root.querySelector("div.show-more-less-html__markup");
  const description = markup ? blockText(markup) : "";
  const criteria = all(root, "ul.description__job-criteria-list li")
    .map((li) => [textOf(li, "h3.description__job-criteria-subheader"), textOf(li, "span.description__job-criteria-text")] as const)
    .filter((c): c is readonly [string, string] => c[0] !== null && c[1] !== null)
    .map(([k, v]) => `${k}: ${v}`);
  const jdText = [description, criteria.join("\n")].filter(Boolean).join("\n");
  const title = textOf(root, "h2.top-card-layout__title") ?? card.title;
  const company = textOf(root, "a.topcard__org-name-link") ?? card.company;
  const location = textOf(root, "span.topcard__flavor--bullet:not(.num-applicants__caption)") ?? card.location;
  if (!description || !title || !company || !location || jdText.length < FEED_MIN_JD_CHARS) return "incomplete";
  return {
    source: "linkedin",
    url: card.url,
    title,
    company,
    companyWebsite: null,
    location,
    workMode: null,
    salaryText: cleanText(textOf(root, ".compensation__salary") ?? card.salaryText) || null,
    postedAt: parsePostedDate(card.postedDate),
    language: detectLanguage(jdText),
    jdText,
  };
}

/** A 429 or 999 from LinkedIn as the block it is (no retry); anything else unchanged. */
function asBlock(err: unknown, path: string): unknown {
  return err instanceof BoardApiError && err.status !== null && BLOCK_STATUSES.has(err.status) ? new DirectReadBlocked("linkedin", LINKEDIN_HOST, path) : err;
}

export async function scanLinkedin(client: BoardApiClient, input: ResearchScanInput, signal?: AbortSignal): Promise<BoardScanResult> {
  const limit = Math.min(input.candidateLimit ?? scanJobLimit(input.criteria.maxJobs), LINKEDIN_MAX_JOB_PAGES);
  let budget = Math.min(input.maxPageViews ?? Number.POSITIVE_INFINITY, LINKEDIN_MAX_SEARCH_PAGES + LINKEDIN_MAX_JOB_PAGES);
  const query = linkedinSearchQuery(input.criteria);
  if (!query) return { jobs: [], note: "no role to search for" };
  let html: string;
  try {
    html = await client.get({ host: LINKEDIN_HOST, path: LINKEDIN_SEARCH_PATH, query }, signal);
  } catch (err) {
    throw asBlock(err, LINKEDIN_SEARCH_PATH);
  }
  budget--;
  const cards = linkedinCards(parseHtml(html));
  if (cards.length === 0) {
    if (isLinkedinChallenge(html)) throw new DirectReadBlocked("linkedin", LINKEDIN_HOST, LINKEDIN_SEARCH_PATH);
    // No results answer an empty fragment; anything else is a page the reader no longer knows.
    if (cleanText(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<!doctype[^>]*>/i, "")) !== "") {
      throw new ApiChanged(LINKEDIN_HOST, LINKEDIN_SEARCH_PATH, `LinkedIn: no job cards on ${LINKEDIN_HOST}${LINKEDIN_SEARCH_PATH} (the page changed)`);
    }
    return { jobs: [], note: "1 search page, no job cards" };
  }

  const excluded = excludedTerms(input);
  let excludedByTitle = 0;
  const queue: LinkedinCard[] = [];
  for (const card of cards) {
    if (excludedTitle(card.title, excluded)) excludedByTitle++;
    else if (queue.length < limit) queue.push(card);
  }

  const jobs: JobCandidate[] = [];
  let jobPages = 0;
  let unreadable = 0;
  for (const card of queue) {
    if (budget <= 0 || jobPages + unreadable >= LINKEDIN_MAX_JOB_PAGES) break;
    const path = linkedinDetailPath(card.jobId);
    let page: string;
    try {
      page = await client.get({ host: LINKEDIN_HOST, path }, signal);
    } catch (err) {
      const blocked = asBlock(err, path);
      if (blocked instanceof DirectReadBlocked) throw blocked;
      // A posting taken down since the search: skipped.
      if ((err instanceof BoardApiError && err.kind === "failed") || err instanceof RedirectRefused) {
        unreadable++;
        budget--;
        continue;
      }
      throw err;
    }
    budget--;
    jobPages++;
    const job = linkedinJob(card, page);
    if (job !== "incomplete") jobs.push(job);
    else if (isLinkedinChallenge(page)) throw new DirectReadBlocked("linkedin", LINKEDIN_HOST, path);
    else unreadable++;
  }
  // Skill self-repair §5.8: job pages answered, but none held a posting the reader could use.
  if (jobPages > 0 && jobs.length === 0) throw new ApiChanged(LINKEDIN_HOST, null, `LinkedIn: ${plural(jobPages, "job page")} on ${LINKEDIN_HOST} gave no complete posting`);
  return finishBoardScan(jobs, input, { excludedByTitle, unreadable, head: `1 search page, ${plural(cards.length, "job card")}, ${plural(jobPages, "job page")} read` });
}

export const linkedinMapper: BoardMapper = {
  source: "linkedin",
  scan: scanLinkedin,
};
