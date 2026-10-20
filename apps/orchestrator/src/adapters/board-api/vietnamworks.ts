// VietnamWorks (2026-10-20 addendum; records/vietnamworks.json): no login. The site's own job search
// is a JSON POST to ms.vietnamworks.com (the record's read-only POST search; BoardApiClient.postSearch
// checks the body against it), and each job page is a guest GET of www.vietnamworks.com/<slug>-<id>-jv
// whose job is in the page's React Server Components payload (parsers/rsc.ts). Search hits cut the
// JD to about 300 characters, so every kept hit's page is read for the full JD.
//   searches:  one per role (sources.ts vietnamworksSearches), the profile's cities as one filter;
//              pages 0, 1, … until page + 1 ≥ meta.nbPages, at most MAX_PAGES_PER_SEARCH, stopping
//              once enough hits are queued;
//   job pages: at most the scan's job limit; input.maxPageViews, when set, caps the total.
// The body is built here from the scan criteria only (never from model output): userId 0, empty
// ranges, newest first. An expired job is skipped; the salary is kept only when the posting shows
// it (isSalaryVisible); the employer's contact fields and the viewer's IP are never kept.
import type { JobCandidate, ResearchScanInput } from "@bs-job-agents/shared";
import { canonicalJobUrl } from "../canonical-url.js";
import { FEED_MIN_JD_CHARS } from "../feeds/filter.js";
import { htmlToText } from "../parsers/dom.js";
import { flightObject } from "../parsers/rsc.js";
import { parsePostedDate } from "../posted-date.js";
import { scanJobLimit, vietnamworksSearches } from "../sources.js";
import { cleanText, detectLanguage } from "../text.js";
import { ApiChanged, BoardApiError, DirectReadBlocked, RedirectRefused, isBotCheckPage, type BoardApiClient } from "./client.js";
import { MAX_PAGES_PER_SEARCH, excludedTerms, excludedTitle, finishBoardScan, plural } from "./json-ld-board.js";
import type { BoardMapper, BoardScanResult } from "./types.js";

export const VNW_SEARCH_HOST = "ms.vietnamworks.com";
export const VNW_SEARCH_PATH = "/job-search/v1.0/search";
export const VNW_JOB_HOST = "www.vietnamworks.com";
/** The headers the site's own search sends (the record's allowlist). */
export const VNW_SEARCH_HEADERS = { "X-Source": "Page-Container" } as const;
/** The fields asked for (each one in the record's retrieveFields). */
export const VNW_RETRIEVE_FIELDS = [
  "jobId", "jobTitle", "jobUrl", "alias", "companyName", "isAnonymous", "workingLocations", "approvedOn", "expiredOn",
  "isSalaryVisible", "salaryMin", "salaryMax", "salaryCurrency", "prettySalary", "jobLevel", "typeWorkingId", "skills",
] as const;
/** Hits per search page (the record allows up to 50). */
export const VNW_PAGE_SIZE = 20;
/** Shown in place of the employer on a posting the employer made anonymous. */
export const VNW_HIDDEN_EMPLOYER = "Hidden employer (VietnamWorks)";
/** Fields never kept from a job object (the employer's contact, the viewer's IP). */
const PRIVATE_FIELDS = ["userIp", "emailAddress", "contactName", "contactEmail"] as const;

const isJobPath = (path: string) => /^\/[a-z0-9-]+-\d+-jv$/.test(path);

/** One search page's body, built from code only. */
export function vietnamworksSearchBody(query: string, cityIds: string | null, page: number, hitsPerPage = VNW_PAGE_SIZE): Record<string, unknown> {
  return {
    userId: 0,
    query,
    filter: cityIds ? [{ field: "workingLocations.cityId", value: cityIds }] : [],
    ranges: [],
    order: [{ field: "approvedOn", value: "desc" }],
    hitsPerPage,
    page,
    retrieveFields: [...VNW_RETRIEVE_FIELDS],
    summaryVersion: "",
  };
}

export interface VnwHit {
  url: string;
  title: string | null;
  /** The search hit itself: the job page's fields fall back to it. */
  job: Record<string, unknown>;
}

/**
 * A search answer's hits and page count, or null when it is not the shape the reader knows. A hit
 * whose expiredOn is past (or that says isExpired) is left out before its page is read.
 */
export function vietnamworksHits(answer: unknown, now: Date = new Date()): { hits: VnwHit[]; nbPages: number; expired: string[] } | null {
  if (typeof answer !== "object" || answer === null) return null;
  const { meta, data } = answer as { meta?: { code?: unknown; nbPages?: unknown }; data?: unknown };
  if (typeof meta !== "object" || meta === null || !Array.isArray(data) || typeof meta.nbPages !== "number") return null;
  if (meta.code !== undefined && meta.code !== 200) return null;
  const hits: VnwHit[] = [];
  const expired: string[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const job = withoutPrivate(item as Record<string, unknown>);
    const url = typeof job.jobUrl === "string" ? canonicalJobUrl(job.jobUrl) : null;
    if (!url) continue;
    const until = typeof job.expiredOn === "string" ? Date.parse(job.expiredOn) : NaN;
    if (job.isExpired === true || until < now.getTime()) {
      expired.push(url);
      continue;
    }
    hits.push({ url, title: str(job.jobTitle), job });
  }
  return { hits, nbPages: meta.nbPages, expired };
}

const str = (v: unknown): string | null => (typeof v === "string" && cleanText(v) ? cleanText(v) : null);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : []);

function withoutPrivate(job: Record<string, unknown>): Record<string, unknown> {
  const out = { ...job };
  for (const k of PRIVATE_FIELDS) delete out[k];
  return out;
}

/** A job page's job object (the page row's jobDetail, references resolved), private fields removed. */
export function vietnamworksJobDetail(html: string): Record<string, unknown> | null {
  const job = flightObject(html, "jobDetail");
  return job && (typeof job.jobId === "number" || typeof job.jobTitle === "string") ? withoutPrivate(job) : null;
}

/** The full JD: description, requirements and benefits, as readable text under their headings. */
export function vietnamworksJdText(job: Record<string, unknown>): string {
  const description = typeof job.jobDescription === "string" ? htmlToText(job.jobDescription) : "";
  const requirement = typeof job.jobRequirement === "string" ? htmlToText(job.jobRequirement) : "";
  const benefits = list(job.benefits)
    .map((b) => (typeof b.benefitValue === "string" ? htmlToText(b.benefitValue) : ""))
    .filter(Boolean)
    .join("\n");
  const vi = detectLanguage(`${description}\n${requirement}`) === "vi";
  const parts: [string, string][] = [
    [vi ? "Mô tả công việc" : "Job description", description],
    [vi ? "Yêu cầu công việc" : "Job requirements", requirement],
    [vi ? "Phúc lợi" : "Benefits", benefits],
  ];
  return parts
    .filter(([, text]) => text)
    .map(([heading, text]) => `${heading}\n${text}`)
    .join("\n");
}

/** A job page as a JobCandidate, or why it cannot be one. The search hit fills fields the page lacks. */
export function vietnamworksJob(url: string, html: string, hit: Record<string, unknown> = {}): JobCandidate | "no_posting" | "incomplete" | "expired" {
  const detail = vietnamworksJobDetail(html);
  if (!detail) return "no_posting";
  if (detail.isExpired === true) return "expired";
  const job = { ...hit, ...detail };
  const title = str(job.jobTitle);
  const company = job.isAnonymous === true ? VNW_HIDDEN_EMPLOYER : str(job.companyName);
  const cities = [...new Set(list(job.workingLocations).map((l) => str(l.cityName)).filter((c): c is string => c !== null))];
  const location = cities.length > 0 ? cities.join(", ") : str(job.address);
  const jdText = vietnamworksJdText(job);
  if (!title || !company || !location || jdText.length < FEED_MIN_JD_CHARS) return "incomplete";
  return {
    source: "vietnamworks",
    url,
    title,
    company,
    companyWebsite: null,
    location,
    workMode: null,
    salaryText: job.isSalaryVisible === true ? str(job.prettySalary) : null,
    postedAt: parsePostedDate(str(job.approvedOn)),
    language: detectLanguage(jdText),
    jdText,
  };
}

export async function scanVietnamworks(client: BoardApiClient, input: ResearchScanInput, signal?: AbortSignal, now: () => Date = () => new Date()): Promise<BoardScanResult> {
  const limit = input.candidateLimit ?? scanJobLimit(input.criteria.maxJobs);
  let budget = input.maxPageViews ?? Number.POSITIVE_INFINITY;
  const excluded = excludedTerms(input);
  const queue: VnwHit[] = [];
  const seen = new Set<string>();
  let searchPages = 0;
  let excludedByTitle = 0;
  // Expired hits (left out before their page) and expired job pages, counted once each.
  const expiredSeen = new Set<string>();
  searches: for (const search of vietnamworksSearches(input.criteria)) {
    for (let page = 0; page < MAX_PAGES_PER_SEARCH; page++) {
      if (queue.length >= Math.min(limit, budget - 1)) break searches;
      const answer = await client.postSearchJson(
        { host: VNW_SEARCH_HOST, path: VNW_SEARCH_PATH, body: vietnamworksSearchBody(search.query, search.cityIds, page), headers: { ...VNW_SEARCH_HEADERS } },
        signal,
      );
      budget--;
      searchPages++;
      const read = vietnamworksHits(answer, now());
      // Skill self-repair §5.8: an answer the reader cannot read is a changed API.
      if (read === null) throw new ApiChanged(VNW_SEARCH_HOST, VNW_SEARCH_PATH, `VietnamWorks: the search on ${VNW_SEARCH_HOST}${VNW_SEARCH_PATH} answered a shape the reader does not know`, "POST");
      for (const url of read.expired) expiredSeen.add(url);
      let added = 0;
      for (const hit of read.hits) {
        if (seen.has(hit.url) || !isJobPath(new URL(hit.url).pathname)) continue;
        seen.add(hit.url);
        added++;
        if (excludedTitle(hit.title, excluded)) {
          excludedByTitle++;
          continue;
        }
        if (queue.length < limit) queue.push(hit);
      }
      if ((added === 0 && read.expired.length === 0) || page + 1 >= read.nbPages) break;
    }
  }

  const jobs: JobCandidate[] = [];
  let jobPages = 0;
  let unreadable = 0;
  let noPosting = 0;
  for (const hit of queue) {
    if (budget <= 0) break;
    const path = new URL(hit.url).pathname;
    let html: string;
    try {
      html = await client.get({ host: VNW_JOB_HOST, path }, signal);
    } catch (err) {
      // A posting taken down since the search (404) or moved off the record's paths: skipped.
      if ((err instanceof BoardApiError && err.kind === "failed") || err instanceof RedirectRefused) {
        unreadable++;
        budget--;
        continue;
      }
      throw err;
    }
    budget--;
    jobPages++;
    const job = vietnamworksJob(hit.url, html, hit.job);
    if (job === "no_posting" && isBotCheckPage(html)) throw new DirectReadBlocked("vietnamworks", VNW_JOB_HOST, path);
    if (job === "expired") expiredSeen.add(hit.url);
    else if (job === "no_posting") noPosting++;
    else if (typeof job === "string") unreadable++;
    else jobs.push(job);
  }
  // Skill self-repair §5.8: only a structural failure is a changed API: no job page held the job
  // object at all (every page read, or at least two of them). An incomplete posting is left out.
  if (jobs.length === 0 && noPosting > 0 && (noPosting === jobPages || noPosting >= 2)) {
    throw new ApiChanged(VNW_JOB_HOST, null, `VietnamWorks: ${plural(noPosting, "job page")} on ${VNW_JOB_HOST} had no job data the reader knows`);
  }
  return finishBoardScan(jobs, input, {
    excludedByTitle,
    unreadable: unreadable + noPosting,
    head: `${plural(searchPages, "search page")}, ${plural(seen.size, "job link")}, ${plural(jobPages, "job page")} read`,
    ...(expiredSeen.size > 0 ? { skipped: [`${expiredSeen.size} expired`] } : {}),
  });
}

export const vietnamworksMapper: BoardMapper = {
  source: "vietnamworks",
  scan: (client, input, signal) => scanVietnamworks(client, input, signal),
};
