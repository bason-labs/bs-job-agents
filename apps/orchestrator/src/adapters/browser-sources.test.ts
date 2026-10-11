// W5 browser sources: VietnamWorks, Wellfound and Upwork (Research reads them in Chrome; these are
// the parsers, canonical URLs, search URLs and checker rules that hold the same knowledge as code).
// Fixtures: VietnamWorks job page and unrendered listing, Wellfound listing and job page, Upwork's
// challenge page are real (one plain GET each, 2026-10-11); VietnamWorks' rendered listing and the
// Upwork listing and job page are SYNTHETIC (marked in the files).
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { researchScanFixture } from "@bs-job-agents/shared/fixtures";
import { SEARCH_PROFILE_DEFAULTS, type JobCandidate, type ResearchScanOutput } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { canonicalJobUrl } from "./canonical-url.js";
import { SourceScanChecker } from "./checker.js";
import type { DomRoot } from "./parsers/dom.js";
import { readJobPage, readListingPage } from "./pages.js";
import { searchUrls, SOURCE_ADAPTERS } from "./sources.js";

const NOW = new Date("2026-10-11T10:00:00+07:00");
const load = (name: string): DomRoot => new JSDOM(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).window.document as unknown as DomRoot;

const criteria = {
  ...SEARCH_PROFILE_DEFAULTS,
  workModes: [...SEARCH_PROFILE_DEFAULTS.workModes],
  seniority: [...SEARCH_PROFILE_DEFAULTS.seniority],
  sources: [...SEARCH_PROFILE_DEFAULTS.sources],
  languages: [...SEARCH_PROFILE_DEFAULTS.languages],
  includeKeywords: [],
  excludeKeywords: [],
  excludeCompanies: [],
  companyTypes: [],
  roles: ["Frontend Developer", "Software Engineer (React/Node)"],
  locations: ["Ho Chi Minh City", "Remote"],
};

describe("VietnamWorks", () => {
  it("reads a real job page from its embedded data (the page renders in the browser)", () => {
    const r = readJobPage("vietnamworks", load("vietnamworks-job.html"), "https://www.vietnamworks.com/ky-su-lap-trinh-ung-dung-fullstack-sofware-developer-1-2-nam-kinh-nghiem-2106434-jv?source=searchResults", NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.job).toMatchObject({
      url: "https://www.vietnamworks.com/ky-su-lap-trinh-ung-dung-fullstack-sofware-developer-1-2-nam-kinh-nghiem-2106434-jv",
      title: "Kỹ Sư Lập Trình Ứng Dụng Fullstack Sofware Developer (1-2 Năm Kinh Nghiệm)",
      company: "Asahi Intecc Hanoi Co., Ltd.",
      location: "Lô G-3, KCN Thăng Long, Xã Thiên Lộc, Hà Nội.",
      salaryText: "Thương lượng",
      postedText: "Đăng 27 ngày trước",
      postedAt: "2026-09-14T03:59:05.000Z",
      language: "vi",
    });
    expect(r.job.jdText).toMatch(/^Mô tả công việc\n- Tham gia phân tích, thiết kế/);
    expect(r.job.jdText).toContain("Yêu cầu công việc\n- Nam/ Nữ, dưới 35 tuổi");
  });

  it("before the cards render, the real page says 6 jobs but has none: the adapter reports it (Research waits for the cards)", () => {
    const r = readListingPage("vietnamworks", load("vietnamworks-listing.unrendered.html"), "https://www.vietnamworks.com/viec-lam?q=frontend-developer&l=29", NOW);
    expect(r).toEqual({ status: "broken", reason: 'the results page says 6 jobs but no job cards were found (looked for a[href$="-jv"])' });
  });

  it("reads the rendered cards' posting links (synthetic rendered page)", () => {
    const r = readListingPage("vietnamworks", load("vietnamworks-listing.html"), "https://www.vietnamworks.com/viec-lam?q=frontend-developer&l=29", NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.page.resultCount).toBe(3);
    expect(r.page.cards.map((c) => [c.url, c.title])).toEqual([
      ["https://www.vietnamworks.com/ky-su-lap-trinh-ung-dung-fullstack-sofware-developer-1-2-nam-kinh-nghiem-2106434-jv", "Kỹ Sư Lập Trình Ứng Dụng Fullstack Sofware Developer (1-2 Năm Kinh Nghiệm)"],
      ["https://www.vietnamworks.com/frontend-developer-reactjs-2100001-jv", "Frontend Developer (ReactJS)"],
      ["https://www.vietnamworks.com/senior-frontend-engineer-2100002-jv", "Senior Frontend Engineer"],
    ]);
  });

  it("search URLs: /viec-lam?q=<role>&l=<city id> (29 HCM, 24 Hà Nội, 17 Đà Nẵng)", () => {
    expect(searchUrls("vietnamworks", { ...criteria, locations: ["Ho Chi Minh City", "Hà Nội", "Đà Nẵng", "Remote"] }).slice(0, 4)).toEqual([
      "https://www.vietnamworks.com/viec-lam?q=frontend-developer&l=29",
      "https://www.vietnamworks.com/viec-lam?q=frontend-developer&l=24",
      "https://www.vietnamworks.com/viec-lam?q=frontend-developer&l=17",
      "https://www.vietnamworks.com/viec-lam?q=frontend-developer",
    ]);
  });
});

describe("Wellfound (real pages, observed 2026-10-11)", () => {
  it("reads one card per job row, with the company of its card", () => {
    const r = readListingPage("wellfound", load("wellfound-listing.html"), "https://wellfound.com/role/r/frontend-engineer", NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.page.resultCount).toBe(553);
    expect(r.page.cards.map((c) => [c.company, c.title, c.location, c.salaryText, c.postedText, c.workMode])).toEqual([
      ["REcollab", "FRONTEND ENGINEER", "Onsite or remote • Chattanooga", "$80k – $105k • 0.25% – 0.75%", "1 week ago", "remote"],
      ["EQLand Technology", "Frontend Engineer", "Remote only • Everywhere", "$80k – $130k • 0.5% – 1.0%", "4 years ago", "remote"],
      ["Made Card", "Senior Frontend Engineer", "Remote only • Everywhere", "$100k – $200k", "1 year ago", "remote"],
      ["Made Card", "Frontend Engineer", "Remote • New York City", "$120k – $160k", "1 year ago", "remote"],
      ["Made Card", "Staff Frontend Engineer", "In office • New York City", "$150k – $200k", "1 year ago", "onsite"],
    ]);
    expect(r.page.cards[1]!.url).toMatch(/^https:\/\/wellfound\.com\/jobs\/\d+-frontend-engineer$/);
  });

  it("reads a job page: JSON-LD plus #job-description", () => {
    const r = readJobPage("wellfound", load("wellfound-job.html"), "https://wellfound.com/jobs/2154673-senior-frontend-engineer?ref=x", NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.job).toMatchObject({
      url: "https://wellfound.com/jobs/2154673-senior-frontend-engineer",
      title: "Senior Frontend Engineer",
      company: "Deep Neuron Lab",
      location: "Remote (Everywhere) • Berlin",
      postedText: "4 years ago",
      postedAt: "2022-04-27T08:40:49.000Z",
      workMode: "remote",
      language: "en",
    });
    expect(r.job.jdText).toMatch(/Write effective, scalable and reusable code/);
  });

  it("remote board: one search per role, the city ignored", () => {
    expect(searchUrls("wellfound", criteria)).toEqual(["https://wellfound.com/role/r/frontend-developer", "https://wellfound.com/role/r/software-engineer"]);
    expect(SOURCE_ADAPTERS.wellfound).toMatchObject({ maxPageViews: 30, minDelayMs: 3000, maxDelayMs: 8000 });
  });
});

describe("Upwork (find only; synthetic listing and job page, real challenge page)", () => {
  it("reads the job tiles; the client is anonymous", () => {
    const r = readListingPage("upwork", load("upwork-listing.html"), "https://www.upwork.com/nx/search/jobs/?q=react&sort=recency", NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.page.resultCount).toBe(1284);
    expect(r.page.cards).toEqual([
      {
        url: "https://www.upwork.com/jobs/~021900000000000000001",
        title: "Senior React Developer for fintech dashboard",
        company: "Upwork client (United States)",
        location: "Remote",
        salaryText: "Hourly: $40-$70",
        postedText: "2 hours ago",
        postedAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
        workMode: "remote",
      },
      expect.objectContaining({ url: "https://www.upwork.com/jobs/~021900000000000000002", salaryText: "Fixed price $500", company: "Upwork client (Singapore)" }),
    ]);
  });

  it("reads a job page (the proposal button is never part of the job)", () => {
    const r = readJobPage("upwork", load("upwork-job.html"), "https://www.upwork.com/jobs/~021900000000000000001", NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.job).toMatchObject({
      url: "https://www.upwork.com/jobs/~021900000000000000001",
      title: "Senior React Developer for fintech dashboard",
      company: "Upwork client (United States)",
      salaryText: "$40.00-$70.00 Hourly",
      language: "en",
    });
    expect(r.job.jdText).not.toMatch(/Connects|proposal/i);
  });

  it("the real Cloudflare challenge is a block (captcha), not a broken adapter", () => {
    expect(readListingPage("upwork", load("upwork-challenge.html"), "https://www.upwork.com/nx/search/jobs/?q=react", NOW)).toMatchObject({ status: "blocked", reason: "captcha" });
  });

  it("search URL and canonical posting URLs", () => {
    expect(searchUrls("upwork", criteria)).toEqual([
      "https://www.upwork.com/nx/search/jobs/?q=Frontend+Developer&sort=recency",
      "https://www.upwork.com/nx/search/jobs/?q=Software+Engineer&sort=recency",
    ]);
    expect(canonicalJobUrl("https://www.upwork.com/freelance-jobs/apply/React-dev_~021234567890123456/?referrer=x")).toBe("https://www.upwork.com/jobs/~021234567890123456");
    expect(canonicalJobUrl("https://www.upwork.com/jobs/~021234567890123456?source=rss")).toBe("https://www.upwork.com/jobs/~021234567890123456");
  });
});

describe("LinkedIn's Remote filter (W5)", () => {
  it("a remote location without a city searches with f_WT=2: Vietnam when it says so, else worldwide", () => {
    expect(searchUrls("linkedin", { ...criteria, roles: ["Frontend Engineer"], locations: ["Remote"] })).toEqual([
      "https://www.linkedin.com/jobs/search?keywords=Frontend+Engineer&location=Worldwide&f_TPR=r604800&f_WT=2",
    ]);
    expect(searchUrls("linkedin", { ...criteria, roles: ["Frontend Engineer"], locations: ["Remote (VN)"] })).toEqual([
      "https://www.linkedin.com/jobs/search?keywords=Frontend+Engineer&location=Vietnam&f_TPR=r604800&f_WT=2",
    ]);
    // A city keeps the work-mode filter as before.
    expect(searchUrls("linkedin", { ...criteria, roles: ["Frontend Engineer"], locations: ["Ho Chi Minh City"] })).toEqual([
      "https://www.linkedin.com/jobs/search?keywords=Frontend+Engineer&location=Ho+Chi+Minh+City%2C+Vietnam&f_TPR=r604800",
    ]);
  });
});

describe("checker rules for the new browser sources", () => {
  const base = researchScanFixture.jobs[0]!;
  const job = (source: string, url: string, over: Partial<JobCandidate> = {}): JobCandidate => ({ ...base, source, url, ...over });
  const out = (jobs: JobCandidate[]): ResearchScanOutput => ({ ...researchScanFixture, jobs, pageViews: jobs.length + 1 });
  const check = (source: string, jobs: JobCandidate[], pageViews?: number) =>
    new SourceScanChecker({ now: () => NOW }).check({
      taskId: 1,
      runId: 1,
      attempt: 1,
      engine: "claude",
      source,
      input: { source, criteria, maxPageViews: SOURCE_ADAPTERS[source as "upwork"]?.maxPageViews ?? null },
      output: { ...out(jobs), ...(pageViews !== undefined ? { pageViews } : {}) },
      screenshots: [],
    });

  it.each([
    ["vietnamworks", "https://www.vietnamworks.com/frontend-developer-reactjs-2100001-jv"],
    ["wellfound", "https://wellfound.com/jobs/2154673-senior-frontend-engineer"],
    ["upwork", "https://www.upwork.com/jobs/~021900000000000000001"],
  ])("%s: a posting URL on the board is accepted", (source, url) => {
    expect(check(source, [job(source, url)])).toEqual({ ok: true });
  });

  it.each([
    ["vietnamworks", "https://www.vietnamworks.com/viec-lam?q=frontend-developer&l=29", /not a VietnamWorks job posting/],
    ["wellfound", "https://wellfound.com/role/r/frontend-engineer", /not a Wellfound job posting/],
    ["upwork", "https://www.upwork.com/nx/search/jobs/?q=react", /not a Upwork job posting/],
    ["upwork", "https://upwork.com.evil.example/jobs/~01", /not on upwork\.com/],
  ])("%s: %s is rejected", (source, url, reason) => {
    expect(check(source, [job(source, url)])).toEqual({ ok: false, adapterBroken: false, reason: expect.stringMatching(reason) });
  });

  it("Wellfound and Upwork are read with Ba's login: over 30 page views is final", () => {
    expect(check("upwork", [job("upwork", "https://www.upwork.com/jobs/~021900000000000000001")], 31)).toMatchObject({ ok: false, adapterBroken: true, reason: expect.stringMatching(/over Upwork's limit of 30/) });
  });
});
