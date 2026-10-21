// API research (design §5.2): the reader shared by the boards whose "API" is their public HTML pages
// (TopCV, ITviec: see their access records' notes). No login, no cookie: a guest GET of the board's
// search page gives the job links in its JSON-LD (an ItemList), and a guest GET of each job page
// gives the posting as a schema.org JobPosting with the full JD. Everything goes through the
// allowlisted BoardApiClient (host gate ≥ 1.5 s per host), so the request count is what a scan costs:
//   search pages: one per role × location (searchUrls, at most 6), up to MAX_PAGES_PER_SEARCH each,
//                 stopping once enough job links are queued;
//   job pages:    at most the scan's job limit (candidateLimit, else 3 × maxJobs, at most 30).
// input.maxPageViews, when set, caps the total. The search profile's filters run in code (the feeds'
// filterPostings: excluded keywords and companies, must-include keywords, seniority, USD floor) — an
// excluded title is skipped before its job page is fetched. A field the board does not give is left
// out (null), never guessed; a posting without a company, a location or a full JD is skipped.
import type { JobCandidate, ResearchScanInput } from "@bs-job-agents/shared";
import { canonicalJobUrl } from "../canonical-url.js";
import { FEED_MIN_JD_CHARS, filterPostings, normaliseTerms, type DropReason } from "../feeds/filter.js";
import { findJobPosting, hasLdType, ldJsonBlocks, ldObjects } from "../parsers/dom.js";
import { parsePostedDate } from "../posted-date.js";
import { scanJobLimit, searchUrls } from "../sources.js";
import { cleanText, detectLanguage } from "../text.js";
import { BoardApiError, RedirectRefused, type BoardApiClient } from "./client.js";
import type { BoardScanResult } from "./types.js";

/** Result pages read per search (the browser skills' limit). */
export const MAX_PAGES_PER_SEARCH = 3;

export interface JsonLdBoard {
  source: "topcv" | "itviec";
  label: string;
  /** The host every request goes to. */
  host: string;
  /** A canonical job URL's path is a job page this reader may open. */
  isJobPath(path: string): boolean;
}

interface Listed {
  url: string;
  /** The title the search page gives (TopCV), else null. */
  title: string | null;
}

/** The job links in a search page's JSON-LD; null when the page has no JSON-LD at all. */
export function listedJobs(html: string): Listed[] | null {
  const blocks = ldJsonBlocks(html);
  if (blocks.length === 0) return null;
  const objects = ldObjects(blocks);
  // ITviec: a top-level ItemList; TopCV: a SearchResultsPage whose mainEntity is the ItemList.
  const list =
    objects.find((o) => hasLdType(o, "ItemList")) ??
    objects.map((o) => o.mainEntity).find((m): m is Record<string, unknown> => typeof m === "object" && m !== null && hasLdType(m as Record<string, unknown>, "ItemList"));
  const elements = Array.isArray(list?.itemListElement) ? (list.itemListElement as unknown[]) : [];
  const out: Listed[] = [];
  for (const el of elements) {
    if (typeof el !== "object" || el === null) continue;
    const e = el as { url?: unknown; name?: unknown; item?: { url?: unknown; name?: unknown } };
    const url = typeof e.item?.url === "string" ? e.item.url : typeof e.url === "string" ? e.url : null;
    const name = typeof e.item?.name === "string" ? e.item.name : typeof e.name === "string" ? e.name : null;
    if (url) out.push({ url, title: cleanText(name) || null });
  }
  return out;
}

/** A job page's posting as a JobCandidate, or why it cannot be one. */
export function jobFromPage(source: JsonLdBoard["source"], url: string, html: string, listedTitle: string | null): JobCandidate | "no_posting" | "incomplete" {
  const ld = findJobPosting(ldJsonBlocks(html));
  if (!ld) return "no_posting";
  const title = ld.title ?? listedTitle;
  const jdText = ld.description ?? "";
  if (!title || !ld.company || ld.regions.length === 0 || jdText.length < FEED_MIN_JD_CHARS) return "incomplete";
  return {
    source,
    url,
    title,
    company: ld.company,
    // The posting's hiringOrganization links to the board's company page, not the company's site.
    companyWebsite: null,
    location: ld.regions.join(", "),
    workMode: ld.remote ? "remote" : null,
    salaryText: ld.salaryText,
    postedAt: parsePostedDate(ld.datePosted),
    language: detectLanguage(jdText),
    jdText,
  };
}

const DROP_NOTES: Record<DropReason, string> = {
  role: "not one of the roles",
  include: "none of the must-include keywords",
  exclude: "an excluded keyword",
  company: "an excluded company",
  seniority: "another seniority",
  region: "outside the time-zone overlap",
  salary: "under the minimum salary",
  snippet: "no full JD",
};

/** A URL of the same search at a page before `page` (no page parameter: page 1). */
function isEarlierPage(url: URL, path: string, page: number): boolean {
  if (url.pathname !== path) return false;
  const n = Number(url.searchParams.get("page") ?? "1");
  return Number.isInteger(n) && n < page;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function scanJsonLdBoard(board: JsonLdBoard, client: BoardApiClient, input: ResearchScanInput, signal?: AbortSignal): Promise<BoardScanResult> {
  const limit = input.candidateLimit ?? scanJobLimit(input.criteria.maxJobs);
  let budget = input.maxPageViews ?? Number.POSITIVE_INFINITY;
  // The board searched by role and city; the role filter is left out (Vietnamese titles rarely
  // repeat the English role), and the time zone does not apply to these boards.
  const criteria = { ...input.criteria, roles: [], timezoneOverlap: null };
  const excluded = input.criteria.excludeKeywords.map((k) => normaliseTerms(k).trim()).filter(Boolean);

  const queue: Listed[] = [];
  const seen = new Set<string>();
  let searchPages = 0;
  let excludedByTitle = 0;
  searches: for (const href of searchUrls(board.source, input.criteria)) {
    const path = new URL(href).pathname;
    for (let page = 1; page <= MAX_PAGES_PER_SEARCH; page++) {
      // Another search page only while the queued links would not already use up the job limit or
      // the rest of the request budget.
      if (queue.length >= Math.min(limit, budget - 1)) break searches;
      let fetched: { body: string; url: URL };
      try {
        fetched = await client.getPage({ host: board.host, path, ...(page > 1 ? { query: { page } } : {}) }, signal);
      } catch (err) {
        // Past the last page the board redirects back to an earlier one (TopCV: ?page=1&u_sr_id=…).
        // That hop was refused (unlisted query) and nothing was sent: the search has no more pages.
        if (page > 1 && err instanceof RedirectRefused && isEarlierPage(err.target, path, page)) break;
        throw err;
      }
      budget--;
      searchPages++;
      // A redirect the record allows, back to an earlier page: no more pages either.
      if (page > 1 && fetched.url.searchParams.get("page") !== String(page) && isEarlierPage(fetched.url, path, page)) break;
      const html = fetched.body;
      const listed = listedJobs(html);
      if (listed === null) throw new BoardApiError("failed", `${board.label}: no job data on ${board.host}${path} (the page changed, or a bot check answered)`);
      let added = 0;
      for (const item of listed) {
        const url = canonicalJobUrl(item.url);
        if (!url || seen.has(url) || !board.isJobPath(new URL(url).pathname)) continue;
        seen.add(url);
        added++;
        if (item.title && excluded.some((k) => normaliseTerms(item.title).includes(` ${k} `))) {
          excludedByTitle++;
          continue;
        }
        if (queue.length < limit) queue.push({ url, title: item.title });
      }
      // No new job on this page: the search has no further pages.
      if (added === 0) break;
    }
  }

  const read: (JobCandidate & { regionText: string; tags: string[] })[] = [];
  let jobPages = 0;
  let unreadable = 0;
  for (const item of queue) {
    if (budget <= 0) break;
    let html: string;
    try {
      html = await client.get({ host: board.host, path: new URL(item.url).pathname }, signal);
    } catch (err) {
      // A posting taken down since the search (404) is skipped; a transient error or a refused
      // token stops the scan as usual.
      // A removed TopCV job redirects to its /viec-lam listing (not in the record): the hop was
      // refused and never sent; skip that posting like a 404.
      if ((err instanceof BoardApiError && err.kind === "failed") || err instanceof RedirectRefused) {
        unreadable++;
        budget--;
        continue;
      }
      throw err;
    }
    budget--;
    jobPages++;
    const job = jobFromPage(board.source, item.url, html, item.title);
    if (typeof job === "string") unreadable++;
    else read.push({ ...job, regionText: "", tags: [] });
  }

  const { kept, dropped } = filterPostings(read, criteria);
  const jobs = kept.slice(0, limit).map(({ regionText: _r, tags: _t, ...job }): JobCandidate => job);
  const counts = new Map<DropReason, number>();
  for (const d of dropped) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  if (excludedByTitle > 0) counts.set("exclude", (counts.get("exclude") ?? 0) + excludedByTitle);
  const why = [...counts].map(([r, n]) => `${n} ${DROP_NOTES[r]}`);
  if (unreadable > 0) why.push(`${unreadable} job page${unreadable === 1 ? "" : "s"} without a complete posting`);
  const note = `${plural(searchPages, "search page")}, ${plural(seen.size, "job link")}, ${plural(jobPages, "job page")} read${why.length > 0 ? ` (left out: ${why.join(", ")})` : ""}`;
  return { jobs, note };
}
