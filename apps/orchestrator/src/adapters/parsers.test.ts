// W4a (§12 source adapters: "Vitest + saved HTML fixtures — field extraction; layout-change
// detection"). The parsers are the code form of the selector hints in bots/research/skills/source-*/:
// if a board changes its markup, these fixtures (re-captured) fail first.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import type { DomRoot } from "./parsers/dom.js";
import { readJobPage, readListingPage } from "./pages.js";

const NOW = new Date("2026-10-11T10:00:00+07:00");

function load(name: string): DomRoot {
  const html = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return new JSDOM(html).window.document as unknown as DomRoot;
}

function fromHtml(html: string): DomRoot {
  return new JSDOM(html).window.document as unknown as DomRoot;
}

describe("TopCV (real pages, observed 2026-10)", () => {
  it("reads the job cards of a listing page", () => {
    const r = readListingPage("topcv", load("topcv-listing.html"), "https://www.topcv.vn/tim-viec-lam-frontend-developer-tai-ho-chi-minh-kl2", NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.page.resultCount).toBe(14);
    expect(r.page.cards).toHaveLength(3);
    expect(r.page.cards[0]).toEqual({
      url: "https://www.topcv.vn/viec-lam/senior-developer-nodejs-reactjs-ai/2316742.html",
      title: "Senior Developer (NodeJS, ReactJS, AI)",
      company: "CÔNG TY TNHH DEKON VIỆT NAM",
      location: "Hồ Chí Minh",
      salaryText: "Thoả thuận",
      postedText: "Đăng 1 tuần trước",
      postedAt: new Date(NOW.getTime() - 7 * 86_400_000).toISOString(),
      workMode: null,
    });
    expect(r.page.cards[1]).toMatchObject({ title: "Frontend Developer (ReactJS, NextJS, TypeScript)", salaryText: "20 - 30 triệu", postedText: "Đăng 3 ngày trước" });
    expect(r.page.cards[2]).toMatchObject({ title: "Flutter Developer", salaryText: "Tới 30 triệu" });
  });

  it("reads a job page: header fields and the full JD (description, requirements, benefits)", () => {
    const r = readJobPage("topcv", load("topcv-job.html"), "https://www.topcv.vn/viec-lam/senior-developer-nodejs-reactjs-ai/2316742.html?ta_source=x", NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const job = r.job;
    expect(job.url).toBe("https://www.topcv.vn/viec-lam/senior-developer-nodejs-reactjs-ai/2316742.html");
    expect(job.title).toBe("Senior Developer (NodeJS, ReactJS, AI)");
    expect(job.company).toBe("CÔNG TY TNHH DEKON VIỆT NAM");
    expect(job.location).toBe("Hồ Chí Minh");
    expect(job.salaryText).toBe("Thoả thuận");
    expect(job.postedAt).toBe("2026-10-01T17:00:00.000Z"); // JSON-LD datePosted 2026-10-02 (VN midnight)
    expect(job.jdText).toMatch(/^Mô tả công việc\n/);
    expect(job.jdText).toContain("Yêu cầu ứng viên");
    expect(job.jdText).toContain("Quyền lợi ứng viên");
    expect(job.jdText).toContain("- Phát triển ứng dụng");
    expect(job.jdText).not.toContain("Việc làm liên quan");
    expect(job.jdText.length).toBeGreaterThan(800);
    expect(job.language).toBe("vi");
  });
});

describe("ITviec (real pages, observed 2026-10)", () => {
  it("reads the job cards; the hidden salary stays null", () => {
    const r = readListingPage("itviec", load("itviec-listing.html"), "https://itviec.com/it-jobs/reactjs/ho-chi-minh-hcm", NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.page.resultCount).toBe(35);
    expect(r.page.cards).toHaveLength(3);
    expect(r.page.cards[2]).toEqual({
      url: "https://itviec.com/it-jobs/frontend-engineer-reactjs-hubble-pte-ltd-0532",
      title: "Frontend Engineer (ReactJS)",
      company: "Hubble Pte. Ltd",
      location: "Ho Chi Minh",
      salaryText: null,
      postedText: "Posted 10 days ago",
      postedAt: new Date(NOW.getTime() - 10 * 86_400_000).toISOString(),
      workMode: "hybrid",
    });
    expect(r.page.cards[0]).toMatchObject({ workMode: "onsite", location: "Ho Chi Minh" });
    expect(r.page.cards[1]).toMatchObject({ location: "Ho Chi Minh - Ha Noi" });
  });

  it("reads a job page", () => {
    const r = readJobPage("itviec", load("itviec-job.html"), "https://itviec.com/it-jobs/frontend-engineer-reactjs-hubble-pte-ltd-0532", NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.job).toMatchObject({
      url: "https://itviec.com/it-jobs/frontend-engineer-reactjs-hubble-pte-ltd-0532",
      title: "Frontend Engineer (ReactJS)",
      company: "Hubble Pte. Ltd",
      location: "261 Hoang Van Thu st, Ho Chi Minh",
      workMode: "hybrid",
      postedText: "Posted 10 days ago",
      salaryText: null,
      language: "en",
    });
    expect(r.job.jdText).toMatch(/Job description/);
    expect(r.job.jdText).toMatch(/Your skills and experience/);
    expect(r.job.jdText.length).toBeGreaterThan(800);
  });
});

describe("LinkedIn guest pages (real pages, observed 2026-10)", () => {
  it("reads the public job search results", () => {
    const r = readListingPage("linkedin", load("linkedin-listing.html"), "https://www.linkedin.com/jobs/search?keywords=Frontend%20Engineer", NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.page.resultCount).toBe(81);
    expect(r.page.cards[0]).toEqual({
      url: "https://www.linkedin.com/jobs/view/4472144344/",
      title: "Senior Frontend Developer",
      company: "Astek Vietnam",
      location: "Ho Chi Minh City, Vietnam",
      salaryText: null,
      postedText: "5 days ago",
      postedAt: "2026-10-04T17:00:00.000Z", // <time datetime="2026-10-05">
      workMode: null,
    });
  });

  it("reads a public job view", () => {
    const r = readJobPage("linkedin", load("linkedin-job.html"), "https://vn.linkedin.com/jobs/view/senior-frontend-developer-at-astek-vietnam-4472144344", NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.job).toMatchObject({
      url: "https://www.linkedin.com/jobs/view/4472144344/",
      title: "Senior Frontend Developer",
      company: "Astek Vietnam",
      location: "Ho Chi Minh City, Vietnam",
      postedText: "5 days ago",
      language: "en",
    });
    expect(r.job.jdText).toMatch(/JOB DESCRIPTION/);
    expect(r.job.jdText.length).toBeGreaterThan(800);
  });

  it("the sign-in wall is a block (needs_login), not a broken adapter", () => {
    const r = readListingPage("linkedin", load("linkedin-authwall.html"), "https://www.linkedin.com/jobs/search?keywords=x", NOW);
    expect(r).toEqual({ status: "blocked", reason: "needs_login", detail: expect.stringMatching(/sign-in wall/i) });
  });
});

describe("career site (real Greenhouse board, observed 2026-10)", () => {
  it("reads the openings list", () => {
    const r = readListingPage("career_site", load("career-site-listing.html"), "https://job-boards.greenhouse.io/axon?offices%5B%5D=4010783003", NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.page.cards.map((c) => [c.title, c.url, c.location])).toEqual([
      ["Android Engineer I", "https://job-boards.greenhouse.io/axon/jobs/5753033003", "Ho Chi Minh City, Ho Chi Minh City, Vietnam"],
      ["Backend Software Engineer", "https://job-boards.greenhouse.io/axon/jobs/7806690003", "Ho Chi Minh City, Ho Chi Minh City, Vietnam"],
      ["Firmware Engineer I", "https://job-boards.greenhouse.io/axon/jobs/7992162003", "Ho Chi Minh City, Ho Chi Minh City, Vietnam"],
    ]);
  });

  it("reads a job page", () => {
    const r = readJobPage("career_site", load("career-site-job.html"), "https://job-boards.greenhouse.io/axon/jobs/7806690003?gh_src=x", NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.job).toMatchObject({
      url: "https://job-boards.greenhouse.io/axon/jobs/7806690003",
      title: "Backend Software Engineer",
      location: "Ho Chi Minh City, Ho Chi Minh City, Vietnam",
      language: "en",
    });
    expect(r.job.jdText).toMatch(/^Join Axon/);
  });
});

describe("layout-change detection", () => {
  it("TopCV with renamed card classes → adapter broken (the page still says 14 jobs)", () => {
    const r = readListingPage("topcv", load("topcv-listing.layout-changed.html"), "https://www.topcv.vn/tim-viec-lam-frontend-developer-tai-ho-chi-minh-kl2", NOW);
    expect(r.status).toBe("broken");
    if (r.status !== "broken") return;
    expect(r.reason).toMatch(/says 14 jobs but no job cards/);
    expect(r.reason).toMatch(/\.job-item-search-result/);
  });

  it.each([
    ["itviec", "itviec-listing.html", "job-card", "jc-v2"],
    ["linkedin", "linkedin-listing.html", "base-search-card__title", "job-card-title-v2"],
  ] as const)("%s with a renamed class → adapter broken", (source, file, from, to) => {
    const html = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8").replaceAll(from, to);
    const r = readListingPage(source, fromHtml(html), "https://example.invalid/", NOW);
    expect(r.status).toBe("broken");
  });

  it("a job page without its JD block → adapter broken", () => {
    const html = readFileSync(new URL("./fixtures/topcv-job.html", import.meta.url), "utf8").replaceAll("box-job-information-detail-item", "jd-section-v2");
    const r = readJobPage("topcv", fromHtml(html), "https://www.topcv.vn/viec-lam/x/1.html", NOW);
    expect(r.status).toBe("broken");
    if (r.status === "broken") expect(r.reason).toMatch(/JD/);
  });

  it("an empty result page that says 0 jobs is a valid empty listing (UC-03 d)", () => {
    const r = readListingPage("topcv", fromHtml("<title>Tuyển dụng 0 việc làm Rust tại Đà Nẵng</title><body><p>Không tìm thấy việc làm phù hợp</p></body>"), "https://www.topcv.vn/x", NOW);
    expect(r).toEqual({ status: "ok", page: { cards: [], resultCount: 0 } });
  });

  it("a page with neither cards nor a result count → adapter broken", () => {
    const r = readListingPage("itviec", fromHtml("<title>ITviec</title><body><div class='new-layout'>…</div></body>"), "https://itviec.com/it-jobs/x", NOW);
    expect(r.status).toBe("broken");
  });

  it("a CAPTCHA / bot check is a block", () => {
    const r = readListingPage("topcv", fromHtml("<title>Just a moment...</title><body><div id='challenge-form'>Verify you are human</div></body>"), "https://www.topcv.vn/x", NOW);
    expect(r).toMatchObject({ status: "blocked", reason: "captcha" });
  });
});
