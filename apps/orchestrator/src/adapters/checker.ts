// The real ScanOutputChecker (PM3 S8 + S11, UC-03 b/c/d, §12 source adapters). The engine calls it
// where a research.scan output settles (schema and self-check passed). Verdicts:
//   ok                       accept
//   implausible (retry)      a job lacks a required field, its URL is off the source's site or not a
//                            posting, a JD is a snippet, a duplicate, a date in the future, more
//                            candidates than the scan's limit, jobs with no page opened
//   adapter broken (final)   the bot reported "Layout changed: …"; every title is a page label; three
//                            or more jobs share one JD; zero jobs on two scans of a source in a row
//                            when the page never said "0 results"; LinkedIn over its page-view
//                            limit or pausing under 3 s (a retry would only add page views)
// The screenshot is the attempt's latest capture (Claude, S7); without one the reason names the page
// URL and the engine records "not captured".
import { ResearchScanInputSchema, type JobCandidate } from "@bs-job-agents/shared";
import type { ScanCheckInput, ScanCheckResult, ScanOutputChecker } from "../engine/scan-check.js";
import { canonicalJobUrl, hostIsOrUnder } from "./canonical-url.js";
import { MIN_JD_CHARS } from "./pages.js";
import { parseSalary } from "./salary.js";
import { isAdapterSource, scanJobLimit, searchUrls, SOURCE_ADAPTERS, type AdapterSource } from "./sources.js";
import { cleanText, foldText } from "./text.js";

/** A page the runner saw the bot open (optional: the engine does not pass these yet). */
export interface PageVisit {
  url: string;
  /** ISO time of the navigation. */
  at: string;
}

export interface SourceScanCheckerOptions {
  now?: () => Date;
  /** Empty scans in a row (page never said "0 results") before the adapter counts as broken. */
  emptyScansBeforeBroken?: number;
}

/** What a posting URL looks like on each board (observed 2026-10). */
const POSTING_PATH: Partial<Record<AdapterSource, RegExp>> = {
  topcv: /^\/(viec-lam\/[^/]+\/\d+\.html|brand\/[^/]+\/tuyen-dung\/[^/]+-j\d+\.html)$/,
  itviec: /^\/it-jobs\/[a-z0-9-]+-\d+(\/content)?\/?$/,
  linkedin: /^\/jobs\/view\/([^/]*-)?\d+\/?$/,
  // W5
  vietnamworks: /^\/[a-z0-9-]+-\d+-jv\/?$/i,
  wellfound: /^\/jobs\/\d+(-[a-z0-9-]+)?\/?$/i,
  upwork: /^\/(jobs\/([^/]*_)?|freelance-jobs\/apply\/[^/]*_)(~|%7e)[0-9a-z]+\/?$/i,
};

/** Page labels a broken read returns instead of a title (folded). */
const PAGE_LABELS = new Set(
  [
    "apply", "apply now", "easy apply", "ung tuyen", "ung tuyen ngay", "xem nhanh", "luu tin", "sign in", "sign in to view salary",
    "dang nhap", "view job", "see more jobs", "job description", "mo ta cong viec", "save", "hot", "super hot", "new", "untitled",
  ].map((s) => foldText(s)),
);

/** A self-check note in which the bot reports that the skill's steps no longer match the page. */
const LAYOUT_NOTE = /^\s*(layout changed|adapter broken)\s*[:-]\s*(.+)$/is;
/** A self-check note in which the bot confirms the search itself found nothing. */
const NO_RESULTS_NOTE = /\b(no results|no jobs found|0 (results|jobs|việc làm)|zero results|không tìm thấy)\b/i;

const MAX_FUTURE_MS = 36 * 3_600_000;
const EARLIEST_POSTED = Date.UTC(2000, 0, 1);

type Verdict = Exclude<ScanCheckResult, { ok: true }>;

function implausible(reason: string): Verdict {
  return { ok: false, adapterBroken: false, reason };
}

function isPageLabel(title: string): boolean {
  const t = foldText(title);
  return !t || PAGE_LABELS.has(t) || /^https?:\/\//.test(t) || !/\p{L}/u.test(t) || t.length > 200;
}

export class SourceScanChecker implements ScanOutputChecker {
  private readonly now: () => Date;
  private readonly emptyLimit: number;
  /** Empty scans in a row per source (in memory: reset when the orchestrator restarts). */
  private readonly emptyStreak = new Map<string, number>();

  constructor(opts: SourceScanCheckerOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.emptyLimit = opts.emptyScansBeforeBroken ?? 2;
  }

  check(req: ScanCheckInput & { pageVisits?: readonly PageVisit[] }): ScanCheckResult {
    if (!isAdapterSource(req.source)) return { ok: true };
    const source = req.source;
    const parsed = ResearchScanInputSchema.safeParse(req.input);
    const criteria = parsed.success ? parsed.data.criteria : null;
    const screenshot = req.screenshots.at(-1) ?? null;
    const pageHint = criteria ? (searchUrls(source, criteria)[0] ?? null) : null;
    const broken = (reason: string, page: string | null = pageHint): Verdict => ({
      ok: false,
      adapterBroken: true,
      reason: screenshot === null && page && !reason.includes(page) ? `${reason} (page: ${page})` : reason,
      screenshot,
    });
    const { output } = req;

    // 1. The bot itself saw the layout change (skill: "Layout changed: <what> <url>").
    for (const item of output.selfCheck) {
      const m = LAYOUT_NOTE.exec(item.note ?? "");
      if (m) {
        const what = cleanText(m[2]);
        return broken(what, /https?:\/\/\S+/.exec(what)?.[0] ?? pageHint);
      }
    }

    // 2. LinkedIn's limits (S11). Over the limit is final: a retry would only open more pages.
    const limits = this.pageLimitProblem(source, req, parsed.success ? parsed.data.maxPageViews : null);
    if (limits) return broken(limits);

    // 3. Each job: required fields, the source's site, a posting URL, full JD, believable values.
    const jobs = output.jobs;
    // An API scan opens no page (AD-6): its postings come from the board's own endpoints.
    if (jobs.length > 0 && output.pageViews === 0 && req.via !== "api") return implausible(`${jobs.length} jobs with full JDs but no page views`);
    if (criteria) {
      const limit = scanJobLimit(criteria.maxJobs);
      if (jobs.length > limit) return implausible(`${jobs.length} jobs, over this scan's limit of ${limit} (3 × maxJobs, at most 30)`);
    }
    const labelled = jobs.filter((j) => isPageLabel(j.title));
    if (jobs.length >= 2 && labelled.length === jobs.length) return broken(`no real job title in ${jobs.length} jobs (e.g. "${cleanText(jobs[0]!.title)}"): the job cards are not being read`);
    const seenUrls = new Map<string, number>();
    for (const [i, job] of jobs.entries()) {
      const problem = this.jobProblem(source, job);
      if (problem) return implausible(`job ${i + 1} (${cleanText(job.company) || "no company"}): ${problem}`);
      const canonical = canonicalJobUrl(job.url!)!;
      const first = seenUrls.get(canonical);
      if (first !== undefined) return implausible(`jobs ${first + 1} and ${i + 1} are the same posting (${canonical})`);
      seenUrls.set(canonical, i);
    }

    // 4. Duplicated garbage: one page read over and over.
    if (jobs.length >= 3) {
      const byJd = new Map<string, number>();
      for (const j of jobs) byJd.set(cleanText(j.jdText), (byJd.get(cleanText(j.jdText)) ?? 0) + 1);
      const most = Math.max(...byJd.values());
      if (most >= 3) return broken(`${most} of ${jobs.length} jobs have the same JD: one page is being read over and over`);
    }

    // 5. Zero jobs on consecutive scans, where the page never said "0 results" (UC-03 d allows one).
    if (jobs.length === 0 && output.blocked === null && output.pageViews > 0) {
      const confirmedEmpty = output.selfCheck.some((s) => NO_RESULTS_NOTE.test(s.note ?? ""));
      if (!confirmedEmpty) {
        const streak = (this.emptyStreak.get(source) ?? 0) + 1;
        this.emptyStreak.set(source, streak);
        if (streak >= this.emptyLimit) {
          this.emptyStreak.set(source, 0);
          return broken(`no jobs on ${streak} scans in a row, and the results page never said "0 results": the results page may have changed`);
        }
      }
    } else if (jobs.length > 0) {
      this.emptyStreak.set(source, 0);
    }
    return { ok: true };
  }

  private pageLimitProblem(source: AdapterSource, req: ScanCheckInput & { pageVisits?: readonly PageVisit[] }, fromInput: number | null): string | null {
    const adapter = SOURCE_ADAPTERS[source];
    if (adapter.maxPageViews === null) return null;
    const limit = Math.min(adapter.maxPageViews, fromInput ?? adapter.maxPageViews);
    if (req.output.pageViews > limit) return `read ${req.output.pageViews} pages, over ${adapter.displayName}'s limit of ${limit} per scan`;
    const visits = req.pageVisits ?? [];
    if (visits.length > limit) return `opened ${visits.length} pages, over ${adapter.displayName}'s limit of ${limit} per scan`;
    const times = visits.map((v) => Date.parse(v.at)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      const gap = times[i]! - times[i - 1]!;
      if (gap < adapter.minDelayMs) {
        return `paused ${(gap / 1000).toFixed(1)} s between pages; ${adapter.displayName} needs ${adapter.minDelayMs / 1000}–${adapter.maxDelayMs / 1000} s`;
      }
    }
    return null;
  }

  private jobProblem(source: AdapterSource, job: JobCandidate): string | null {
    const adapter = SOURCE_ADAPTERS[source];
    if (job.source !== source) return `says it comes from ${job.source}, not ${source}`;
    if (job.url === null) return "no posting URL";
    let url: URL;
    try {
      url = new URL(job.url);
    } catch {
      return `posting URL "${job.url}" is not a URL`;
    }
    if (adapter.hosts.length > 0 && !adapter.hosts.some((h) => hostIsOrUnder(url.hostname, h))) return `posting URL ${job.url} is not on ${adapter.hosts.join(" or ")}`;
    const path = POSTING_PATH[source];
    if (path && !path.test(url.pathname)) return `${job.url} is not a ${adapter.displayName} job posting (a search or company page?)`;
    for (const field of ["title", "company", "location"] as const) {
      if (!cleanText(job[field])) return `no ${field}`;
    }
    if (isPageLabel(job.title)) return `title "${cleanText(job.title)}" is a page label, not a job title`;
    if (cleanText(job.jdText).length < MIN_JD_CHARS) return `the JD is a snippet (${cleanText(job.jdText).length} characters), not the full text`;
    if (job.postedAt !== null) {
      const t = Date.parse(job.postedAt);
      if (t > this.now().getTime() + MAX_FUTURE_MS) return `posting date ${job.postedAt} is in the future`;
      if (t < EARLIEST_POSTED) return `posting date ${job.postedAt} is not believable`;
    }
    const salary = parseSalary(job.salaryText);
    if (salary && salary.min !== null && salary.max !== null && salary.min > salary.max) return `salary "${job.salaryText}" has its minimum above its maximum`;
    return null;
  }
}
