// API research (design §5.2): TopCV and ITviec are read as a guest from their public pages' JSON-LD.
// The pages here are rebuilt from the researcher's scrubbed captures (fixtures/<source>/*.json, the
// JSON-LD as the board served it on 2026-10-19), wrapped in a minimal HTML page.
import { readFileSync } from "node:fs";
import { API_READER_BOARDS, SEARCH_PROFILE_DEFAULTS, sourceAccessRecord, type JobCandidate, type ResearchScanInput, type SearchProfileFieldsBase } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { settleScanOutput } from "../../engine/scan-settle.js";
import { HostGate, MIN_HOST_GAP_MS, type HttpFetch } from "../http/index.js";
import { BoardApiClient, BoardApiError } from "./client.js";
import { itviecMapper } from "./itviec.js";
import { jobFromPage, listedJobs } from "./json-ld-board.js";
import { BOARD_MAPPERS } from "./mappers.js";
import { topcvMapper } from "./topcv.js";
import type { BoardMapper } from "./types.js";

type Capture = { _capture: { url: string }; data: Record<string, unknown> };
const fixture = (source: string, name: string): Capture => JSON.parse(readFileSync(new URL(`./fixtures/${source}/${name}.json`, import.meta.url), "utf8")) as Capture;
const page = (...ld: unknown[]) => `<!doctype html><html><head><title>t</title>${ld.map((d) => `<script type="application/ld+json">${JSON.stringify(d)}</script>`).join("")}</head><body></body></html>`;

const topcvSearch = fixture("topcv", "search");
const topcvDetail = fixture("topcv", "detail");
const itviecSearch = fixture("itviec", "search");
const itviecDetail = fixture("itviec", "detail");

/** The captured job page for its own URL; any other job page: the same posting under that title. */
function jobPage(detail: Capture, url: string, title = `Job at ${url}`): string {
  if (url === detail._capture.url) return page(detail.data);
  return page({ ...detail.data, title });
}

const criteria = (over: Partial<SearchProfileFieldsBase> = {}): SearchProfileFieldsBase => ({
  ...SEARCH_PROFILE_DEFAULTS,
  workModes: [...SEARCH_PROFILE_DEFAULTS.workModes],
  roles: ["React Developer"],
  locations: [],
  seniority: [],
  sources: ["topcv", "itviec"],
  languages: ["en"],
  includeKeywords: [],
  excludeKeywords: [],
  excludeCompanies: [],
  minSalary: null,
  ...over,
});

const input = (source: "topcv" | "itviec", over: Partial<ResearchScanInput> & { criteria?: SearchProfileFieldsBase } = {}): ResearchScanInput => ({
  source,
  criteria: criteria(),
  maxPageViews: null,
  candidateLimit: 3,
  ...over,
});

function harness(source: "topcv" | "itviec", answer: (url: URL) => { status: number; body?: string; location?: string }) {
  const calls: string[] = [];
  const at: number[] = [];
  let now = 0;
  const fetch: HttpFetch = async (url) => {
    calls.push(url);
    at.push(now);
    const a = answer(new URL(url));
    return { ok: a.status < 300, status: a.status, text: async () => a.body ?? "", headers: { get: (n: string) => (n.toLowerCase() === "location" ? (a.location ?? null) : null) } };
  };
  // A fake clock: the gate's waits move it, so `clock()` is the scan's wall time under the 1.5 s gap.
  const gate = new HostGate({ now: () => now, sleep: async (ms) => void (now += Math.max(0, ms)) });
  const client = new BoardApiClient({ record: sourceAccessRecord(source), path: "account_api", fetch, gate, credentials: null });
  return { client, calls, at, clock: () => now };
}

const settle = (source: string, jobs: unknown[]) =>
  settleScanOutput({ source, taskInput: {}, jobs, selfCheck: [], taskId: 1, runId: 1, attempt: 1, engine: "claude" });

describe("BOARD_MAPPERS", () => {
  it("TopCV and ITviec have a mapper; LinkedIn and the boards with no GET endpoint do not (they stay on the browser)", () => {
    expect(Object.keys(BOARD_MAPPERS).sort()).toEqual(["itviec", "topcv"]);
    // The shared list the web's mock orchestrator uses.
    expect([...API_READER_BOARDS].sort()).toEqual(Object.keys(BOARD_MAPPERS).sort());
  });
});

describe("listedJobs", () => {
  it("reads TopCV's SearchResultsPage and ITviec's ItemList; a page with no JSON-LD is null", () => {
    expect(listedJobs(page(topcvSearch.data))!.map((j) => j.title)).toContain("Nhân Viên ReactJS Front End Developer (Middle)");
    expect(listedJobs(page(itviecSearch.data))).toHaveLength(5);
    expect(listedJobs(page(itviecSearch.data))![0]).toEqual({ url: itviecDetail._capture.url, title: null });
    expect(listedJobs("<html><title>Just a moment...</title></html>")).toBeNull();
    expect(listedJobs(page({ "@type": "WebSite", name: "x" }))).toEqual([]);
  });
});

describe("TopCV mapper", () => {
  const answer = (url: URL) => {
    if (url.pathname === "/tim-viec-lam-react-developer") return { status: 200, body: page(topcvSearch.data) };
    if (url.pathname.startsWith("/viec-lam/")) return { status: 200, body: jobPage(topcvDetail, url.toString()) };
    return { status: 404 };
  };

  it("one search page, then one job page per posting up to the limit; full JD, fields from the JobPosting, never invented", async () => {
    const h = harness("topcv", answer);
    const result = await topcvMapper.scan(h.client, input("topcv", { candidateLimit: 3 }));
    expect(h.calls).toEqual([
      "https://www.topcv.vn/tim-viec-lam-react-developer",
      "https://www.topcv.vn/viec-lam/senior-php-developer-fullstack-reactjs-laravel/2330324.html",
      "https://www.topcv.vn/viec-lam/fullstack-developer-reactjs-nestjs-postgresql/2325079.html",
      "https://www.topcv.vn/viec-lam/nhan-vien-reactjs-front-end-developer-middle/2320500.html",
    ]);
    expect(result.jobs).toHaveLength(3);
    const job = result.jobs.find((j) => j.url === topcvDetail._capture.url)!;
    expect(job).toMatchObject({
      source: "topcv",
      title: "Nhân Viên ReactJS Front End Developer (Middle)",
      company: "CÔNG TY CỔ PHẦN CHUYỂN ĐỔI SỐ AIONTECH",
      companyWebsite: null,
      location: "Hà Nội",
      workMode: null,
      salaryText: "Thoả thuận",
      postedAt: "2026-10-07T17:00:00.000Z",
      language: "vi",
    });
    expect(job.jdText).toMatch(/^Mô tả công việc\n- Phát triển/);
    expect(job.jdText).toContain("Yêu cầu ứng viên");
    expect(job.jdText).not.toMatch(/<[a-z]/);
    expect(result.note).toBe("1 search page, 5 job links, 3 job pages read");

    // The same checks a browser scan's output passes, including "full JD text (not a snippet)".
    const settled = await settle("topcv", result.jobs);
    expect(settled.kind).toBe("ok");
    expect(settled.dropped).toEqual([]);
  });

  it("requests to the board are at least 1.5 s apart", async () => {
    const h = harness("topcv", answer);
    await topcvMapper.scan(h.client, input("topcv", { candidateLimit: 3 }));
    for (let i = 1; i < h.at.length; i++) expect(h.at[i]! - h.at[i - 1]!).toBeGreaterThanOrEqual(MIN_HOST_GAP_MS);
  });

  it("a city search uses the board's city slug; an excluded keyword in a listed title skips its job page", async () => {
    const h = harness("topcv", (url) => (url.pathname === "/tim-viec-lam-react-developer-tai-ha-noi-kl1" ? { status: 200, body: page(topcvSearch.data) } : answer(url)));
    const result = await topcvMapper.scan(h.client, input("topcv", { candidateLimit: 10, criteria: criteria({ locations: ["Hà Nội"], excludeKeywords: ["PHP"] }) }));
    expect(h.calls[0]).toBe("https://www.topcv.vn/tim-viec-lam-react-developer-tai-ha-noi-kl1");
    expect(h.calls.some((u) => u.includes("senior-php"))).toBe(false);
    // Page 2 lists the same postings again: no new link, so no page 3.
    expect(h.calls.filter((u) => u.includes("tim-viec-lam"))).toEqual(["https://www.topcv.vn/tim-viec-lam-react-developer-tai-ha-noi-kl1", "https://www.topcv.vn/tim-viec-lam-react-developer-tai-ha-noi-kl1?page=2"]);
    expect(result.jobs).toHaveLength(4);
    expect(result.note).toContain("1 an excluded keyword");
  });

  it("past the last page TopCV redirects ?page=2 back to page 1 with a tracking id: the hop is not followed and paging ends", async () => {
    const h = harness("topcv", (url) =>
      url.pathname === "/tim-viec-lam-react-developer" && url.searchParams.get("page") === "2"
        ? { status: 302, location: "https://www.topcv.vn/tim-viec-lam-react-developer?page=1&u_sr_id=TRACK123" }
        : answer(url),
    );
    const result = await topcvMapper.scan(h.client, input("topcv", { candidateLimit: 6 }));
    expect(h.calls.filter((u) => u.includes("tim-viec-lam"))).toEqual(["https://www.topcv.vn/tim-viec-lam-react-developer", "https://www.topcv.vn/tim-viec-lam-react-developer?page=2"]);
    expect(h.calls.some((u) => u.includes("u_sr_id"))).toBe(false);
    expect(result.jobs).toHaveLength(5);
  });

  it("a redirect from a search page to anything else is refused and fails the scan (nothing is sent to it)", async () => {
    const h = harness("topcv", (url) => (url.pathname === "/tim-viec-lam-react-developer" ? { status: 302, location: "https://evil.example/tim-viec-lam-react-developer" } : answer(url)));
    await expect(topcvMapper.scan(h.client, input("topcv"))).rejects.toThrow(/evil\.example/);
    expect(h.calls).toHaveLength(1);
  });

  it("a job page without a company, a location or a full JD is left out, not filled in; a 404 job page is skipped", async () => {
    const h = harness("topcv", (url) => {
      if (url.pathname.includes("2330324")) return { status: 404 };
      if (url.pathname.includes("2325079")) return { status: 200, body: page({ ...topcvDetail.data, hiringOrganization: undefined }) };
      if (url.pathname.includes("2334261")) return { status: 200, body: page({ ...topcvDetail.data, description: "<p>Short teaser.</p>" }) };
      if (url.pathname.includes("2329960")) return { status: 200, body: page({ ...topcvDetail.data, jobLocation: undefined }) };
      return answer(url);
    });
    const result = await topcvMapper.scan(h.client, input("topcv", { candidateLimit: 10 }));
    expect(result.jobs.map((j) => j.url)).toEqual([topcvDetail._capture.url]);
    expect(result.note).toContain("4 job pages without a complete posting");
  });

  it("a search page with no JSON-LD (a bot check or a new layout) fails the scan instead of reporting no jobs", async () => {
    const h = harness("topcv", () => ({ status: 200, body: "<html><title>Just a moment...</title></html>" }));
    await expect(topcvMapper.scan(h.client, input("topcv"))).rejects.toThrow(BoardApiError);
    expect(h.calls).toHaveLength(1);
  });

  it("maxPageViews caps every request of the scan", async () => {
    const h = harness("topcv", answer);
    const result = await topcvMapper.scan(h.client, input("topcv", { candidateLimit: 10, maxPageViews: 3 }));
    expect(h.calls).toHaveLength(3);
    expect(result.jobs).toHaveLength(2);
  });
});

describe("salary text from the JobPosting", () => {
  it("keeps an amount or 'negotiable'; ITviec's guest placeholder \"You'll love it\" is no salary", () => {
    const salaryOf = (value: unknown) => (jobFromPage("itviec", itviecDetail._capture.url, page({ ...itviecDetail.data, baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: { "@type": "QuantitativeValue", value } } }), null) as JobCandidate).salaryText;
    expect(salaryOf("You'll love it")).toBeNull();
    expect(salaryOf("1,500 - 3,000 USD")).toBe("1,500 - 3,000 USD");
    expect(salaryOf("Thoả thuận")).toBe("Thoả thuận");
    expect(salaryOf(undefined)).toBeNull();
  });
});

describe("ITviec mapper", () => {
  const more = (n: number) => ({ ...itviecSearch.data, itemListElement: Array.from({ length: 5 }, (_, i) => ({ "@type": "ListItem", position: i + 1, url: `https://itviec.com/it-jobs/react-developer-company-${n}${i}?lab_feature=preview` })) });
  const answer = (url: URL) => {
    if (url.pathname === "/it-jobs/react-developer/ho-chi-minh-hcm") {
      return { status: 200, body: page(url.searchParams.get("page") === "2" ? more(9) : url.searchParams.get("page") === "3" ? { ...itviecSearch.data, itemListElement: [] } : itviecSearch.data) };
    }
    if (/^\/it-jobs\/[^/]+-\d+$/.test(url.pathname)) return { status: 200, body: jobPage(itviecDetail, url.toString()) };
    return { status: 404 };
  };

  it("pages through the search until it has enough links, reads each job page, and never opens the apply URL", async () => {
    const h = harness("itviec", answer);
    const result = await itviecMapper.scan(h.client, input("itviec", { candidateLimit: 7, criteria: criteria({ locations: ["Ho Chi Minh City"] }) }));
    expect(h.calls.slice(0, 2)).toEqual(["https://itviec.com/it-jobs/react-developer/ho-chi-minh-hcm", "https://itviec.com/it-jobs/react-developer/ho-chi-minh-hcm?page=2"]);
    expect(h.calls).toHaveLength(2 + 7);
    expect(h.calls.some((u) => u.includes("job_applications") || u.includes("lab_feature"))).toBe(false);
    expect(result.jobs).toHaveLength(7);
    const job = result.jobs[0]!;
    expect(job).toMatchObject({
      source: "itviec",
      url: "https://itviec.com/it-jobs/fintech-frontend-dev-javascript-react-new-wealth-2706",
      title: "FinTech Frontend Dev JavaScript, React",
      company: "New Wealth",
      location: "Hồ Chí Minh",
      salaryText: "1,500 - 3,000 USD",
      postedAt: "2026-10-18T17:00:00.000Z",
      language: "en",
      workMode: null,
    });
    expect(job.jdText).toMatch(/^Top 3 Reasons To Join Us\n/);
    expect(job.jdText).toContain("Your Skills and Experience");
    expect((await settle("itviec", result.jobs)).kind).toBe("ok");
  });

  it("the search profile's filters run in code: an excluded company is dropped", async () => {
    const h = harness("itviec", answer);
    const result = await itviecMapper.scan(h.client, input("itviec", { candidateLimit: 3, criteria: criteria({ locations: ["Ho Chi Minh City"], excludeCompanies: ["New Wealth"] }) }));
    expect(result.jobs).toEqual([]);
    expect(result.note).toContain("3 an excluded company");
  });
});

describe("a measured scan (the PR's before/after numbers)", () => {
  it.each<[string, BoardMapper, "topcv" | "itviec"]>([
    ["TopCV", topcvMapper, "topcv"],
    ["ITviec", itviecMapper, "itviec"],
  ])("%s: requests and wall time for a 5-posting scan under the 1.5 s gap, no Chrome, no Claude", async (_label, mapper, source) => {
    const h = harness(source, (url) => {
      if (url.pathname.startsWith("/tim-viec-lam") || url.pathname === "/it-jobs/react-developer") return { status: 200, body: page((source === "topcv" ? topcvSearch : itviecSearch).data) };
      return { status: 200, body: jobPage(source === "topcv" ? topcvDetail : itviecDetail, url.toString()) };
    });
    const result = await mapper.scan(h.client, input(source, { candidateLimit: 5 }));
    // 1 search page + 5 job pages, each at least 1.5 s after the previous one.
    expect(h.calls).toHaveLength(6);
    expect(result.jobs).toHaveLength(5);
    expect(h.clock()).toBe(5 * MIN_HOST_GAP_MS);
  });
});
