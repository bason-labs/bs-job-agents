// LinkedIn (2026-10-20 addendum): the logged-out jobs-guest search and job pages only, with the
// limits fixed in code (1 search page, at most 10 job pages, 3 s between requests) and a stop on
// the first 429, 999 or challenge page. Answers are the scrubbed captures in fixtures/linkedin/; no
// request leaves the test and none goes to linkedin.com.
import { readFileSync } from "node:fs";
import { SEARCH_PROFILE_DEFAULTS, sourceAccessRecord, type ResearchScanInput, type SearchProfileFieldsBase } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { settleScanOutput } from "../../engine/scan-settle.js";
import type { SecretStore } from "../../engine/ports.js";
import { HostGate, type HttpFetch } from "../http/index.js";
import { parseHtml } from "../parsers/html.js";
import { ApiChanged, BoardApiClient, DirectReadBlocked, EndpointNotAllowed } from "./client.js";
import {
  LINKEDIN_MAX_JOB_PAGES,
  LINKEDIN_MIN_GAP_MS,
  isLinkedinChallenge,
  linkedinCards,
  linkedinJob,
  linkedinMapper,
  linkedinSearchQuery,
} from "./linkedin.js";
import { BoardApiScanner } from "./scanner.js";

const read = (name: string) => readFileSync(new URL(`./fixtures/linkedin/${name}`, import.meta.url), "utf8");
const SEARCH = read("search.html");
const DETAIL = read("job-4415809801.html");
/** The cookie challenge LinkedIn answered the second search page with (shape only, hand-made). */
const CHALLENGE = '<html><head><meta http-equiv="refresh" content="1;url=https://www.linkedin.com" /><script type="text/javascript">var _0x1=1;document.cookie="x=1";</script></head><body></body></html>';

/** A search fragment of `n` cards (the captured card under new ids). */
function manyCards(n: number): string {
  const card = SEARCH.split("<li>")[1]!;
  return Array.from({ length: n }, (_, i) => `<li>${card.replaceAll("4415809801", String(5_000_000_000 + i))}`).join("\n");
}
/** The captured job page for another posting id. */
const detailFor = (id: string) => DETAIL.replaceAll("4415809801", id);

const criteria = (over: Partial<SearchProfileFieldsBase> = {}): SearchProfileFieldsBase => ({
  ...SEARCH_PROFILE_DEFAULTS,
  workModes: [...SEARCH_PROFILE_DEFAULTS.workModes],
  roles: ["Java Engineer", "Backend Developer"],
  locations: ["Ho Chi Minh", "Ha Noi"],
  seniority: [],
  sources: ["linkedin"],
  languages: ["en"],
  includeKeywords: [],
  excludeKeywords: [],
  excludeCompanies: [],
  minSalary: null,
  ...over,
});
const input = (over: Partial<ResearchScanInput> = {}): ResearchScanInput => ({ source: "linkedin", criteria: criteria(), maxPageViews: null, candidateLimit: 30, ...over });

type Answer = { status: number; body?: string };
function harness(opts: { search?: () => Answer; job?: (id: string, n: number) => Answer; credentials?: Record<string, string> | null } = {}) {
  const calls: { url: URL; headers: Record<string, string>; at: number }[] = [];
  let now = 0;
  const fetch: HttpFetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, headers: init.headers, at: now });
    const id = /\/jobPosting\/(\d+)$/.exec(u.pathname)?.[1];
    const a = id ? (opts.job ?? ((i) => ({ status: 200, body: detailFor(i) })))(id, calls.length) : (opts.search ?? (() => ({ status: 200, body: SEARCH })))();
    return { ok: a.status < 300, status: a.status, text: async () => a.body ?? "", headers: { get: () => null } };
  };
  // The production gate (linkedin.com keeps 3000 ms) on a fake clock.
  const gate = new HostGate({ now: () => now, sleep: async (ms) => void (now += Math.max(0, ms)) });
  const client = new BoardApiClient({ record: sourceAccessRecord("linkedin"), path: "account_api", fetch, gate, credentials: opts.credentials ?? null });
  return { client, calls, fetch, gate };
}

describe("LinkedIn guest pages", () => {
  it("cards: id from the urn, the /jobs/view/<id>/ URL, title, company, location, date; tracking links never kept", () => {
    const cards = linkedinCards(parseHtml(SEARCH));
    expect(cards).toHaveLength(3);
    expect(cards[0]).toEqual({
      jobId: "4415809801",
      url: "https://www.linkedin.com/jobs/view/4415809801/",
      title: "Medior Java Engineer - Personal Banking",
      company: "NAB Innovation Centre Vietnam",
      location: "Ho Chi Minh City, Vietnam",
      postedDate: "2026-09-20",
      salaryText: null,
    });
    expect(JSON.stringify(cards)).not.toMatch(/trackingId|refId|vn\.linkedin\.com/);
  });

  it("a job page: the full JD and its criteria, from the top card; recruiter, face-pile and sign-in blocks ignored", () => {
    const [card] = linkedinCards(parseHtml(SEARCH));
    const job = linkedinJob(card!, DETAIL);
    if (job === "incomplete") throw new Error("incomplete");
    expect(job).toMatchObject({ source: "linkedin", url: "https://www.linkedin.com/jobs/view/4415809801/", title: "Medior Java Engineer - Personal Banking", company: "NAB Innovation Centre Vietnam", location: "Ho Chi Minh City, Vietnam", companyWebsite: null, language: "en", postedAt: "2026-09-19T17:00:00.000Z" });
    expect(job.jdText).toMatch(/^YOUR JOB RESPONSIBILITIES\n- Design, develop/);
    expect(job.jdText).toContain("- 4+ years experience as a Java designer/developer");
    expect(job.jdText).toMatch(/Seniority level: Mid-Senior level\nEmployment type: Full-time\nIndustries: Software Development/);
    expect(job.jdText).not.toMatch(/applicants|Sign in|Show more|Join now|Referrals/i);
  });

  it("a job page for another posting, or without the JD, is incomplete", () => {
    const [card] = linkedinCards(parseHtml(SEARCH));
    expect(linkedinJob(card!, detailFor("123"))).toBe("incomplete");
    expect(linkedinJob(card!, "<html><body><h2 class='top-card-layout__title'>X</h2></body></html>")).toBe("incomplete");
  });

  it("the search query is the profile's first search: keywords, location, last 7 days, start 0 (and nothing else)", () => {
    expect(linkedinSearchQuery(criteria())).toEqual({ keywords: "Java Engineer", location: "Ho Chi Minh City, Vietnam", f_TPR: "r604800", start: "0" });
    expect(linkedinSearchQuery(criteria({ roles: [] }))).toBeNull();
  });

  it("challenge pages: the cookie challenge, a bot check, the authwall; a real search or job page is none", () => {
    expect(isLinkedinChallenge(CHALLENGE)).toBe(true);
    expect(isLinkedinChallenge(read("../../../fixtures/linkedin-authwall.html"))).toBe(true);
    expect(isLinkedinChallenge("<html><title>Just a moment...</title></html>")).toBe(true);
    expect(isLinkedinChallenge(DETAIL)).toBe(false);
  });
});

describe("LinkedIn mapper", () => {
  it("1 search page (start=0), then one job page per card, every request on the record; jobs settle", async () => {
    const h = harness();
    const result = await linkedinMapper.scan(h.client, input());
    expect(h.calls.map((c) => c.url.pathname)).toEqual([
      "/jobs-guest/jobs/api/seeMoreJobPostings/search",
      "/jobs-guest/jobs/api/jobPosting/4415809801",
      "/jobs-guest/jobs/api/jobPosting/4464820030",
      expect.stringMatching(/^\/jobs-guest\/jobs\/api\/jobPosting\/\d+$/),
    ]);
    expect(Object.fromEntries(h.calls[0]!.url.searchParams)).toEqual({ keywords: "Java Engineer", location: "Ho Chi Minh City, Vietnam", f_TPR: "r604800", start: "0" });
    expect(result.jobs).toHaveLength(3);
    expect(result.note).toBe("1 search page, 3 job cards, 3 job pages read");
    const settled = await settleScanOutput({ source: "linkedin", taskInput: {}, jobs: result.jobs, selfCheck: [], taskId: 1, runId: 1, attempt: 1, engine: "claude" });
    expect(settled.kind).toBe("ok");
  });

  it("limits in code: never a second search page, at most 10 job pages, at least 3000 ms between requests", async () => {
    const h = harness({ search: () => ({ status: 200, body: manyCards(25) }) });
    await linkedinMapper.scan(h.client, input({ candidateLimit: 30 }));
    const searches = h.calls.filter((c) => c.url.pathname.endsWith("/search"));
    expect(searches).toHaveLength(1);
    expect(searches[0]!.url.searchParams.get("start")).toBe("0");
    expect(h.calls.filter((c) => c.url.pathname.includes("/jobPosting/"))).toHaveLength(LINKEDIN_MAX_JOB_PAGES);
    expect(LINKEDIN_MAX_JOB_PAGES).toBe(10);
    expect(LINKEDIN_MIN_GAP_MS).toBe(3_000);
    for (let i = 1; i < h.calls.length; i++) expect(h.calls[i]!.at - h.calls[i - 1]!.at).toBeGreaterThanOrEqual(3_000);
  });

  it("maxPageViews and the job limit cap it further", async () => {
    const h = harness({ search: () => ({ status: 200, body: manyCards(25) }) });
    await linkedinMapper.scan(h.client, input({ maxPageViews: 4 }));
    expect(h.calls).toHaveLength(4);
    const h2 = harness({ search: () => ({ status: 200, body: manyCards(25) }) });
    await linkedinMapper.scan(h2.client, input({ candidateLimit: 2 }));
    expect(h2.calls).toHaveLength(3);
  });

  it("a 429 or a 999 on the search or a job page stops the scan at once as a blocked direct read: no retry, no further request", async () => {
    for (const status of [429, 999]) {
      const s = harness({ search: () => ({ status }) });
      await expect(linkedinMapper.scan(s.client, input())).rejects.toBeInstanceOf(DirectReadBlocked);
      expect(s.calls, `search ${status}`).toHaveLength(1);
      const j = harness({ job: (_id, n) => (n === 3 ? { status } : { status: 200, body: detailFor(_id) }) });
      await expect(linkedinMapper.scan(j.client, input())).rejects.toBeInstanceOf(DirectReadBlocked);
      expect(j.calls, `job ${status}`).toHaveLength(3);
    }
  });

  it("a 200 challenge page (search or job) is a blocked direct read too", async () => {
    await expect(linkedinMapper.scan(harness({ search: () => ({ status: 200, body: CHALLENGE }) }).client, input())).rejects.toBeInstanceOf(DirectReadBlocked);
    const j = harness({ job: () => ({ status: 200, body: CHALLENGE }) });
    await expect(linkedinMapper.scan(j.client, input())).rejects.toBeInstanceOf(DirectReadBlocked);
    expect(j.calls).toHaveLength(2);
  });

  it("no results is no jobs; a page with no cards that is not empty is a changed API; job pages with no posting are a changed API", async () => {
    expect(await linkedinMapper.scan(harness({ search: () => ({ status: 200, body: "" }) }).client, input())).toMatchObject({ jobs: [] });
    await expect(linkedinMapper.scan(harness({ search: () => ({ status: 200, body: "<ul><li><div class='new-card'>x</div></li></ul>" }) }).client, input())).rejects.toBeInstanceOf(ApiChanged);
    await expect(linkedinMapper.scan(harness({ job: () => ({ status: 200, body: "<div>redesigned</div>" }) }).client, input())).rejects.toBeInstanceOf(ApiChanged);
  });

  it("an excluded keyword in a card's title skips its job page; a 404 job page is skipped", async () => {
    const [, second, third] = linkedinCards(parseHtml(SEARCH));
    const h = harness({ job: (id) => (id === third!.jobId ? { status: 404 } : { status: 200, body: detailFor(id) }) });
    const result = await linkedinMapper.scan(h.client, input({ criteria: criteria({ excludeKeywords: ["Full-Stack"] }) }));
    expect(second!.title).toMatch(/Full-Stack/);
    expect(h.calls.map((c) => c.url.pathname)).not.toContain(`/jobs-guest/jobs/api/jobPosting/${second!.jobId}`);
    expect(h.calls.map((c) => c.url.pathname)).toContain(`/jobs-guest/jobs/api/jobPosting/${third!.jobId}`);
    expect(result.jobs).toHaveLength(1);
    expect(result.note).toMatch(/1 an excluded keyword/);
  });
});

describe("no cookie, ever", () => {
  it("the scanner sends no Cookie header even when the secrets file has li_at and JSESSIONID", async () => {
    const h = harness();
    const secrets: SecretStore = { credentials: () => ({ li_at: "AQEDAR-li-at-SECRET", JSESSIONID: '"ajax:123"', "csrf-token": "ajax:123" }), has: () => true };
    const scanner = new BoardApiScanner({ fetch: h.fetch, gate: h.gate, secrets });
    const result = await scanner.scan("linkedin", { path: "account_api", input: input() });
    expect(result.jobs).toHaveLength(3);
    expect(h.calls.length).toBeGreaterThan(0);
    for (const c of h.calls) {
      expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toEqual(expect.arrayContaining(["cookie"]));
      expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toContain("csrf-token");
      expect(JSON.stringify(c.headers)).not.toMatch(/AQEDAR|ajax:123/);
    }
  });

  it("a reader can never set a Cookie header itself, and the voyager API is not on the record", async () => {
    const h = harness();
    await expect(h.client.get({ host: "www.linkedin.com", path: "/jobs-guest/jobs/api/jobPosting/1", headers: { Cookie: "li_at=x" } })).rejects.toThrow(EndpointNotAllowed);
    await expect(h.client.get({ host: "www.linkedin.com", path: "/voyager/api/voyagerJobsDashJobCards" })).rejects.toThrow(EndpointNotAllowed);
    await expect(h.client.get({ host: "www.linkedin.com", path: "/jobs-guest/jobs/api/jobPosting/abc" })).rejects.toThrow(EndpointNotAllowed);
    await expect(h.client.get({ host: "www.linkedin.com", path: "/jobs-guest/jobs/api/seeMoreJobPostings/search", query: { keywords: "x", f_WT: "2" } })).rejects.toThrow(EndpointNotAllowed);
    expect(h.calls).toHaveLength(0);
  });
});
