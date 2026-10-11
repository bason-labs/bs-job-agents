// W4a (PM3 S8 + S11, UC-03 b/c/d, §12): the real ScanOutputChecker. Per source: required fields,
// posting URL on the source's site, plausibility, layout-change reports, LinkedIn's limits.
import { researchScanFixture } from "@bs-job-agents/shared/fixtures";
import { SEARCH_PROFILE_DEFAULTS, type JobCandidate, type ResearchScanOutput } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import type { ScanCheckInput } from "../engine/scan-check.js";
import { createScanOutputChecker } from "./index.js";
import { SourceScanChecker, type PageVisit } from "./checker.js";

const NOW = new Date("2026-10-11T10:00:00+07:00");
const criteria = { ...SEARCH_PROFILE_DEFAULTS, roles: ["Frontend Engineer"], locations: ["Ho Chi Minh City"] };
const itviecJob = researchScanFixture.jobs.find((j) => j.source === "itviec")!;
const topcvJob = researchScanFixture.jobs.find((j) => j.source === "topcv")!;
const JD = itviecJob.jdText;

function linkedinJob(id: number, over: Partial<JobCandidate> = {}): JobCandidate {
  return {
    ...itviecJob,
    source: "linkedin",
    url: `https://www.linkedin.com/jobs/view/${4472144300 + id}/`,
    title: `Frontend Engineer ${id}`,
    company: `Company ${id}`,
    jdText: `${JD}\n\nPosting ${id}`,
    ...over,
  };
}

function output(jobs: JobCandidate[], over: Partial<ResearchScanOutput> = {}): ResearchScanOutput {
  return { ...researchScanFixture, jobs, pageViews: jobs.length + 1, ...over };
}

function input(source: string, out: ResearchScanOutput, over: Partial<ScanCheckInput> & { pageVisits?: PageVisit[] } = {}): ScanCheckInput {
  return {
    taskId: 1,
    runId: 1,
    attempt: 1,
    engine: "claude",
    source,
    input: { source, criteria, maxPageViews: source === "linkedin" ? 40 : null },
    output: out,
    screenshots: [],
    ...over,
  };
}

const checker = () => new SourceScanChecker({ now: () => NOW });

describe("createScanOutputChecker (production wiring)", () => {
  it("is one shared checker", () => {
    expect(createScanOutputChecker()).toBe(createScanOutputChecker());
    expect(createScanOutputChecker()).toBeInstanceOf(SourceScanChecker);
  });

  it("accepts the FakeRunner's scans (what production-wiring.test runs)", async () => {
    const c = checker();
    expect(await c.check(input("itviec", output([itviecJob])))).toEqual({ ok: true });
    expect(await c.check(input("topcv", output([topcvJob])))).toEqual({ ok: true });
  });
});

describe("required fields and the source's site (implausible → retry)", () => {
  const rejected = (reason: RegExp) => ({ ok: false, adapterBroken: false, reason: expect.stringMatching(reason) });

  it("a sourceless check (not a board) is accepted", () => {
    expect(checker().check(input("unknown", output([itviecJob])))).toEqual({ ok: true });
  });

  it("a job from another source", () => {
    expect(checker().check(input("topcv", output([itviecJob])))).toEqual(rejected(/job 1 .*comes from itviec, not topcv/));
  });

  it("a posting URL off the source's site", () => {
    const job = { ...itviecJob, url: "https://itviec.com.evil.example/it-jobs/x" };
    expect(checker().check(input("itviec", output([job])))).toEqual(rejected(/not on itviec\.com/));
  });

  it("a search page instead of a posting", () => {
    const job = { ...topcvJob, url: "https://www.topcv.vn/tim-viec-lam-frontend-developer-tai-ho-chi-minh-kl2" };
    expect(checker().check(input("topcv", output([job])))).toEqual(rejected(/not a TopCV job posting/));
  });

  it("missing posting URL", () => {
    expect(checker().check(input("itviec", output([{ ...itviecJob, url: null }])))).toEqual(rejected(/no posting URL/));
  });

  it.each([
    ["title", "   "],
    ["company", " "],
    ["location", "\n"],
  ] as const)("a blank %s", (field, value) => {
    expect(checker().check(input("itviec", output([{ ...itviecJob, [field]: value }])))).toEqual(rejected(new RegExp(`no ${field}`)));
  });

  it("a page label read as the title", () => {
    const jobs = [itviecJob, { ...linkedinJob(1), source: "itviec", url: "https://itviec.com/it-jobs/x-1", title: "Apply now" }];
    expect(checker().check(input("itviec", output(jobs)))).toEqual(rejected(/job 2 .*title "Apply now" is a page label/));
  });

  it("a snippet instead of the full JD", () => {
    expect(checker().check(input("itviec", output([{ ...itviecJob, jdText: "Build things with React." }])))).toEqual(rejected(/snippet/));
  });

  it("the same posting twice", () => {
    const dup = { ...itviecJob, url: `${itviecJob.url}?lab_feature=preview_jd_page`, jdText: `${JD} ` };
    expect(checker().check(input("itviec", output([itviecJob, dup])))).toEqual(rejected(/same posting/));
  });

  it("a posting date in the future", () => {
    expect(checker().check(input("itviec", output([{ ...itviecJob, postedAt: "2026-12-01T00:00:00+07:00" }])))).toEqual(rejected(/in the future/));
  });

  it("a salary range upside down", () => {
    expect(checker().check(input("topcv", output([{ ...topcvJob, salaryText: "35 - 25 triệu" }])))).toEqual(rejected(/salary/));
  });

  it("jobs with full JDs but no page opened", () => {
    expect(checker().check(input("itviec", output([itviecJob], { pageViews: 0 })))).toEqual(rejected(/no page views/));
  });

  it("more candidates than the scan's limit (3 × maxJobs)", () => {
    const jobs = Array.from({ length: 16 }, (_, i) => ({ ...linkedinJob(i), source: "itviec", url: `https://itviec.com/it-jobs/job-${i}` }));
    expect(checker().check(input("itviec", output(jobs)))).toEqual(rejected(/16 jobs, over this scan's limit of 15/));
  });
});

describe("adapter broken (no retry, UC-03 b)", () => {
  it("the bot reports a layout change in a self-check note → broken, with the latest screenshot", () => {
    const out = output([], {
      pageViews: 1,
      selfCheck: [{ item: "Every job has a reachable URL", passed: true, note: "Layout changed: no job cards (.job-item-search-result) on https://www.topcv.vn/tim-viec-lam-react-tai-ho-chi-minh-kl2" }],
    });
    const r = checker().check(input("topcv", out, { screenshots: ["screenshots/1-1/1.png", "screenshots/1-1/2.png"] }));
    expect(r).toEqual({ ok: false, adapterBroken: true, reason: "no job cards (.job-item-search-result) on https://www.topcv.vn/tim-viec-lam-react-tai-ho-chi-minh-kl2", screenshot: "screenshots/1-1/2.png" });
  });

  it("without a screenshot (Codex): 'not captured' plus the page URL in the reason", () => {
    const out = output([], { pageViews: 1, selfCheck: [{ item: "Every job has a reachable URL", passed: true, note: "Layout changed: the JD block is missing" }] });
    const r = checker().check(input("topcv", out, { engine: "codex" }));
    expect(r).toEqual({
      ok: false,
      adapterBroken: true,
      reason: "the JD block is missing (page: https://www.topcv.vn/tim-viec-lam-frontend-engineer-tai-ho-chi-minh-kl2)",
      screenshot: null,
    });
  });

  it("every title is a page label → the cards are not being read", () => {
    const jobs = [1, 2, 3].map((i) => ({ ...linkedinJob(i), source: "itviec", url: `https://itviec.com/it-jobs/j-${i}`, title: "Sign in to view salary" }));
    expect(checker().check(input("itviec", output(jobs)))).toMatchObject({ ok: false, adapterBroken: true, reason: expect.stringMatching(/no real job title/) });
  });

  it("three or more jobs with the same JD → one page read over and over", () => {
    const jobs = [1, 2, 3].map((i) => ({ ...linkedinJob(i), jdText: JD }));
    expect(checker().check(input("linkedin", output(jobs)))).toMatchObject({ ok: false, adapterBroken: true, reason: expect.stringMatching(/same JD/) });
  });

  it("zero jobs on two scans in a row (the page never said 0 results) → broken", () => {
    const c = checker();
    const empty = output([], { pageViews: 2 });
    expect(c.check(input("itviec", empty))).toEqual({ ok: true }); // UC-03 d: an empty list is valid…
    expect(c.check(input("itviec", empty, { taskId: 2 }))).toMatchObject({ ok: false, adapterBroken: true, reason: expect.stringMatching(/no jobs on 2 scans in a row/) });
  });

  it("a confirmed empty search, a block, or jobs in between do not count", () => {
    const c = checker();
    const confirmed = output([], { pageViews: 1, selfCheck: [{ item: "Every job has a reachable URL", passed: true, note: "No results: the page says 0 jobs" }] });
    const empty = output([], { pageViews: 1 });
    const blocked = output([], { pageViews: 1, blocked: { reason: "captcha", site: "itviec.com", detail: null } });
    expect(c.check(input("itviec", confirmed))).toEqual({ ok: true });
    expect(c.check(input("itviec", confirmed))).toEqual({ ok: true });
    expect(c.check(input("itviec", empty))).toEqual({ ok: true });
    expect(c.check(input("itviec", blocked))).toEqual({ ok: true });
    expect(c.check(input("itviec", output([itviecJob])))).toEqual({ ok: true });
    expect(c.check(input("itviec", empty))).toEqual({ ok: true });
    expect(c.check(input("topcv", empty))).toEqual({ ok: true }); // per source
  });
});

describe("LinkedIn limits (S11, UC-03 c)", () => {
  it("at most 40 page views per scan: 41 fails the branch without a retry", () => {
    const r = checker().check(input("linkedin", output([linkedinJob(1)], { pageViews: 41 })));
    expect(r).toMatchObject({ ok: false, adapterBroken: true, reason: expect.stringMatching(/41 pages.*limit of 40/) });
  });

  it("the task's own lower limit wins", () => {
    const r = checker().check(input("linkedin", output([linkedinJob(1)], { pageViews: 31 }), { input: { source: "linkedin", criteria, maxPageViews: 30 } }));
    expect(r).toMatchObject({ ok: false, adapterBroken: true, reason: expect.stringMatching(/limit of 30/) });
  });

  it("40 page views is fine", () => {
    expect(checker().check(input("linkedin", output([linkedinJob(1)], { pageViews: 40 })))).toEqual({ ok: true });
  });

  it("when the runner reports page visits: too many, or a pause under 3 s, fails the branch", () => {
    const at = (s: number) => new Date(NOW.getTime() + s * 1000).toISOString();
    const visit = (s: number, i: number): PageVisit => ({ url: `https://www.linkedin.com/jobs/view/${i}/`, at: at(s) });
    const ok = [0, 4, 9, 13].map(visit);
    expect(checker().check(input("linkedin", output([linkedinJob(1)], { pageViews: 4 }), { pageVisits: ok }))).toEqual({ ok: true });

    const fast = [0, 4, 5.5, 10].map(visit);
    expect(checker().check(input("linkedin", output([linkedinJob(1)], { pageViews: 4 }), { pageVisits: fast }))).toMatchObject({
      ok: false,
      adapterBroken: true,
      reason: expect.stringMatching(/paused 1\.5 s between pages; LinkedIn needs 3–8 s/),
    });

    const many = Array.from({ length: 42 }, (_, i) => visit(i * 4, i));
    expect(checker().check(input("linkedin", output([linkedinJob(1)], { pageViews: 3 }), { pageVisits: many }))).toMatchObject({
      ok: false,
      adapterBroken: true,
      reason: expect.stringMatching(/opened 42 pages/),
    });
  });

  it("the other boards have no page-view limit", () => {
    const jobs = [itviecJob];
    expect(checker().check(input("itviec", output(jobs, { pageViews: 120 })))).toEqual({ ok: true });
  });
});
