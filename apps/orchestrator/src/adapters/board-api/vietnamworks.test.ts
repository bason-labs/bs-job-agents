// VietnamWorks (2026-10-20 addendum): the read-only search POST, then one guest GET per job page,
// read from its RSC payload. Answers come from the scrubbed captures in fixtures/vietnamworks/ (the
// search trimmed to 3 hits, the job page to the rows reachable from jobDetail); other job pages are
// rebuilt from a search hit in the same RSC shape. No request leaves the test.
import { readFileSync } from "node:fs";
import { SEARCH_PROFILE_DEFAULTS, sourceAccessRecord, type ResearchScanInput, type SearchProfileFieldsBase } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { settleScanOutput } from "../../engine/scan-settle.js";
import { HostGate, type HttpFetch } from "../http/index.js";
import { vietnamworksSearches } from "../sources.js";
import { ApiChanged, BoardApiClient, DirectReadBlocked } from "./client.js";
import { VNW_HIDDEN_EMPLOYER, VNW_RETRIEVE_FIELDS, vietnamworksHits, vietnamworksJob, vietnamworksMapper, vietnamworksSearchBody } from "./vietnamworks.js";

const read = (name: string) => readFileSync(new URL(`./fixtures/vietnamworks/${name}`, import.meta.url), "utf8");
type Hit = Record<string, unknown> & { jobId: number; jobUrl: string };
const SEARCH = JSON.parse(read("search.json")) as { meta: Record<string, unknown>; data: Hit[] };
const DETAIL = read("job-2110333.html");
const DETAIL_URL = SEARCH.data.find((h) => h.jobId === 2110333)!.jobUrl;

/** A job page in the site's RSC shape for a job object. */
function jobPage(job: Record<string, unknown>): string {
  const push = (s: string) => `<script>self.__next_f.push(${JSON.stringify([1, s])})</script>`;
  return `<!DOCTYPE html><html><body>${push(`1:${JSON.stringify(job)}\n`)}${push('b:["$","$L27",null,{"jobDetail":"$1","userIp":["0.0.0.0"]}]\n')}</body></html>`;
}
const LONG = "<p>Phát triển và vận hành các dịch vụ backend bằng Java, Spring Boot; làm việc với đội sản phẩm để thiết kế API, viết kiểm thử, theo dõi hiệu năng và hỗ trợ triển khai lên môi trường production.</p>";
const pageFor = (hit: Hit, over: Record<string, unknown> = {}) => jobPage({ ...hit, jobDescription: LONG, jobRequirement: LONG, ...over });

const criteria = (over: Partial<SearchProfileFieldsBase> = {}): SearchProfileFieldsBase => ({
  ...SEARCH_PROFILE_DEFAULTS,
  workModes: [...SEARCH_PROFILE_DEFAULTS.workModes],
  roles: ["Java Developer"],
  locations: ["Ho Chi Minh"],
  seniority: [],
  sources: ["vietnamworks"],
  languages: ["en", "vi"],
  includeKeywords: [],
  excludeKeywords: [],
  excludeCompanies: [],
  minSalary: null,
  ...over,
});
const input = (over: Partial<ResearchScanInput> = {}): ResearchScanInput => ({ source: "vietnamworks", criteria: criteria(), maxPageViews: null, candidateLimit: 3, ...over });

type Answer = { status: number; body?: string };
function harness(opts: { search?: (body: Record<string, unknown>) => Answer; job?: (url: URL) => Answer } = {}) {
  const calls: { method: string; url: string; body: Record<string, unknown> | null; headers: Record<string, string>; at: number }[] = [];
  let now = 0;
  const search = opts.search ?? (() => ({ status: 200, body: JSON.stringify(SEARCH) }));
  const job =
    opts.job ??
    ((url: URL) => {
      if (url.toString() === DETAIL_URL) return { status: 200, body: DETAIL };
      const hit = SEARCH.data.find((h) => h.jobUrl === url.toString());
      return hit ? { status: 200, body: pageFor(hit) } : { status: 404 };
    });
  const fetch: HttpFetch = async (url, init) => {
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method: init.method ?? "GET", url, body, headers: init.headers, at: now });
    const a = init.method === "POST" ? search(body!) : job(new URL(url));
    return { ok: a.status < 300, status: a.status, text: async () => a.body ?? "", headers: { get: () => null } };
  };
  const gate = new HostGate({ now: () => now, sleep: async (ms) => void (now += Math.max(0, ms)) });
  const client = new BoardApiClient({ record: sourceAccessRecord("vietnamworks"), path: "account_api", fetch, gate, credentials: null });
  return { client, calls };
}

describe("vietnamworksSearches (city filter from the search profile)", () => {
  it("Ho Chi Minh 29, Ha Noi 24, Da Nang 17 as one comma list; a remote or other location means no city filter", () => {
    expect(vietnamworksSearches({ roles: ["Java Developer (Spring)"], locations: ["TP.HCM"] })).toEqual([{ query: "Java Developer", cityIds: "29" }]);
    expect(vietnamworksSearches({ roles: ["Java"], locations: ["Hà Nội", "Đà Nẵng"] })).toEqual([{ query: "Java", cityIds: "24,17" }]);
    expect(vietnamworksSearches({ roles: ["Java"], locations: ["Remote"] })).toEqual([{ query: "Java", cityIds: null }]);
    expect(vietnamworksSearches({ roles: ["Java"], locations: ["Ho Chi Minh", "Singapore"] })).toEqual([{ query: "Java", cityIds: null }]);
    expect(vietnamworksSearches({ roles: ["Java"], locations: [] })).toEqual([{ query: "Java", cityIds: null }]);
    expect(vietnamworksSearches({ roles: ["A", "B", "C", "D", "E", "F", "G"], locations: [] })).toHaveLength(6);
  });

  it("the body is built in code: guest userId 0, empty ranges, newest first, only the record's retrieved fields", () => {
    expect(vietnamworksSearchBody("java", "29", 1)).toEqual({
      userId: 0,
      query: "java",
      filter: [{ field: "workingLocations.cityId", value: "29" }],
      ranges: [],
      order: [{ field: "approvedOn", value: "desc" }],
      hitsPerPage: 20,
      page: 1,
      retrieveFields: [...VNW_RETRIEVE_FIELDS],
      summaryVersion: "",
    });
    expect(vietnamworksSearchBody("java", null, 0).filter).toEqual([]);
    const [post] = sourceAccessRecord("vietnamworks").internalApiPostSearchEndpoints!;
    for (const f of VNW_RETRIEVE_FIELDS) expect(post!.retrieveFields).toContain(f);
  });
});

describe("vietnamworksJob (a job page's RSC payload)", () => {
  it("full JD = description + requirements + benefits; salary only when visible; posted date, city, company from the job", () => {
    const job = vietnamworksJob(DETAIL_URL, DETAIL);
    expect(job).toMatchObject({
      source: "vietnamworks",
      url: DETAIL_URL,
      title: "(Middle, Senior) BackEnd Engineer (Java, Spring Boot) - Khối Công nghệ thông tin (2025TD923)",
      company: "NGÂN HÀNG TMCP QUÂN ĐỘI – MBBANK",
      companyWebsite: null,
      location: "Ha Noi",
      workMode: null,
      salaryText: "26tr-50tr ₫/tháng",
      postedAt: "2026-09-22T10:14:28.000Z",
      language: "vi",
    });
    if (typeof job === "string") throw new Error(job);
    expect(job.jdText).toMatch(/^Mô tả công việc\nMB là ngân hàng/);
    expect(job.jdText).toContain("\nYêu cầu công việc\n");
    expect(job.jdText).toContain("\nPhúc lợi\n");
    expect(job.jdText).not.toMatch(/<\/?p>/);
    expect(job.jdText.length).toBeGreaterThan(1000);
  });

  it("a hidden salary is no salary; an anonymous employer is hidden; an expired job is skipped; the contact fields and IP are never kept", () => {
    const hit = SEARCH.data.find((h) => h.jobId === 2116796)!;
    expect(hit.isSalaryVisible).toBe(false);
    const hidden = vietnamworksJob(hit.jobUrl, pageFor(hit, { emailAddress: "hr@example.com", contactName: "Nguyen Van A" }));
    expect(hidden).toMatchObject({ salaryText: null, location: "Ho Chi Minh, Ha Noi" });
    expect(JSON.stringify(hidden)).not.toMatch(/hr@example|Nguyen Van A|0\.0\.0\.0/);
    expect(vietnamworksJob(hit.jobUrl, pageFor(hit, { isAnonymous: true }))).toMatchObject({ company: VNW_HIDDEN_EMPLOYER });
    expect(vietnamworksJob(hit.jobUrl, pageFor(hit, { isExpired: true }))).toBe("expired");
  });

  it("a page without the job, or a job without a full JD, is not a posting", () => {
    expect(vietnamworksJob(DETAIL_URL, "<html><body>moved</body></html>")).toBe("no_posting");
    const hit = SEARCH.data[0]!;
    expect(vietnamworksJob(hit.jobUrl, jobPage({ ...hit, jobDescription: "<p>short</p>", jobRequirement: "" }))).toBe("incomplete");
  });

  it("vietnamworksHits reads the search answer; another shape is null; expired hits are skipped", () => {
    const hits = vietnamworksHits(SEARCH)!;
    expect(hits.nbPages).toBe(2);
    expect(hits.hits.map((h) => h.url)).toEqual(SEARCH.data.map((h) => h.jobUrl));
    expect(JSON.stringify(hits)).not.toMatch(/"emailAddress"|"contactName"/);
    expect(vietnamworksHits({ data: [] })).toBeNull();
    expect(vietnamworksHits({ meta: { code: 500, nbPages: 1 }, data: [] })).toBeNull();
    expect(vietnamworksHits({ meta: { code: 200, nbPages: 1 }, data: [{ ...SEARCH.data[0], isExpired: true }] })!.hits).toEqual([]);
  });
});

describe("VietnamWorks mapper", () => {
  it("one search POST, then one job page per hit up to the limit; every request on the record, no cookie; jobs settle", async () => {
    const h = harness();
    const result = await vietnamworksMapper.scan(h.client, input());
    expect(h.calls.map((c) => `${c.method} ${new URL(c.url).host}${new URL(c.url).pathname}`)).toEqual([
      "POST ms.vietnamworks.com/job-search/v1.0/search",
      ...SEARCH.data.map((d) => `GET www.vietnamworks.com${new URL(d.jobUrl).pathname}`),
    ]);
    expect(h.calls[0]!.body).toEqual(vietnamworksSearchBody("Java Developer", "29", 0));
    expect(h.calls[0]!.headers).toMatchObject({ "Content-Type": "application/json", "X-Source": "Page-Container" });
    for (const c of h.calls) expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toContain("cookie");
    expect(result.jobs).toHaveLength(3);
    expect(result.note).toBe("1 search page, 3 job links, 3 job pages read");
    const settled = await settleScanOutput({ source: "vietnamworks", taskInput: {}, jobs: result.jobs, selfCheck: [], taskId: 1, runId: 1, attempt: 1, engine: "claude" });
    expect(settled.kind).toBe("ok");
  });

  it("requests to one host are at least 1.5 s apart", async () => {
    const h = harness();
    await vietnamworksMapper.scan(h.client, input());
    const gets = h.calls.filter((c) => c.method === "GET").map((c) => c.at);
    for (let i = 1; i < gets.length; i++) expect(gets[i]! - gets[i - 1]!).toBeGreaterThanOrEqual(1_500);
  });

  it("pages 0, 1, … while more hits are needed and stop at page + 1 >= nbPages", async () => {
    const pages: number[] = [];
    const h = harness({
      search: (body) => {
        pages.push(body.page as number);
        // Page n gives the three hits under new ids, so each page adds new links.
        const page = body.page as number;
        const data = SEARCH.data.map((d) => ({ ...d, jobId: d.jobId + page, jobUrl: d.jobUrl.replace(/-(\d+)-jv$/, (_, id: string) => `-${Number(id) + page}-jv`) }));
        return { status: 200, body: JSON.stringify({ ...SEARCH, meta: { ...SEARCH.meta, page, nbPages: 2 }, data }) };
      },
      job: (url) => {
        const id = Number(/-(\d+)-jv$/.exec(url.pathname)![1]);
        const base = SEARCH.data.find((d) => d.jobId === id || d.jobId === id - 1)!;
        return { status: 200, body: pageFor({ ...base, jobId: id, jobUrl: url.toString() }) };
      },
    });
    const result = await vietnamworksMapper.scan(h.client, input({ candidateLimit: 10 }));
    expect(pages).toEqual([0, 1]);
    expect(result.jobs).toHaveLength(6);
  });

  it("stops paging once the limit is queued and caps each search at 3 pages even when the site has 200", async () => {
    /** A site with 200 pages: every page gives three new hits. */
    const endless = () => {
      const pages: number[] = [];
      let n = 0;
      const h = harness({
        search: (body) => {
          pages.push(body.page as number);
          const data = SEARCH.data.map((d) => ({ ...d, jobId: 9_000_000 + ++n, jobUrl: `https://www.vietnamworks.com/job-${9_000_000 + n}-jv` }));
          return { status: 200, body: JSON.stringify({ ...SEARCH, meta: { ...SEARCH.meta, nbPages: 200 }, data }) };
        },
        job: (url) => ({ status: 200, body: pageFor({ ...SEARCH.data[0]!, jobUrl: url.toString() }) }),
      });
      return { ...h, pages };
    };
    const few = endless();
    await vietnamworksMapper.scan(few.client, input({ candidateLimit: 2 }));
    expect(few.pages).toEqual([0]);
    expect(few.calls.filter((c) => c.method === "GET")).toHaveLength(2);
    const many = endless();
    const result = await vietnamworksMapper.scan(many.client, input({ candidateLimit: 30 }));
    expect(many.pages).toEqual([0, 1, 2]);
    expect(many.calls.filter((c) => c.method === "GET")).toHaveLength(9);
    expect(result.jobs).toHaveLength(9);
  });

  it("maxPageViews caps every request of the scan", async () => {
    const h = harness();
    await vietnamworksMapper.scan(h.client, input({ maxPageViews: 2 }));
    expect(h.calls).toHaveLength(2);
  });

  it("an excluded keyword in a hit's title skips its job page; a 404 job page is skipped; an expired job is left out", async () => {
    const expired = SEARCH.data.find((d) => d.jobId === 2119126)!;
    const h = harness({
      job: (url) => {
        if (url.toString() === DETAIL_URL) return { status: 404 };
        if (url.toString() === expired.jobUrl) return { status: 200, body: pageFor(expired, { isExpired: true }) };
        return { status: 200, body: pageFor(SEARCH.data.find((d) => d.jobUrl === url.toString())!) };
      },
    });
    const result = await vietnamworksMapper.scan(h.client, input({ criteria: criteria({ excludeKeywords: ["5 YOE"] }) }));
    expect(h.calls.filter((c) => c.method === "GET").map((c) => c.url)).toEqual([DETAIL_URL, expired.jobUrl]);
    expect(result.jobs).toEqual([]);
    expect(result.note).toMatch(/1 an excluded keyword/);
    expect(result.note).toMatch(/1 expired/);
  });

  it("skill self-repair §5.8: a search answer the reader cannot read, or job pages with no job, are a changed API; a bot check is a blocked read", async () => {
    await expect(vietnamworksMapper.scan(harness({ search: () => ({ status: 200, body: '{"error":"x"}' }) }).client, input())).rejects.toMatchObject({ name: "ApiChanged", method: "POST", host: "ms.vietnamworks.com" });
    await expect(vietnamworksMapper.scan(harness({ search: () => ({ status: 404 }) }).client, input())).rejects.toBeInstanceOf(ApiChanged);
    await expect(vietnamworksMapper.scan(harness({ job: () => ({ status: 200, body: "<html><body>new layout</body></html>" }) }).client, input())).rejects.toBeInstanceOf(ApiChanged);
    await expect(vietnamworksMapper.scan(harness({ job: () => ({ status: 200, body: "<html><title>Just a moment...</title></html>" }) }).client, input())).rejects.toBeInstanceOf(DirectReadBlocked);
  });

  it("a search with no hits is no jobs, not a failure", async () => {
    const h = harness({ search: () => ({ status: 200, body: JSON.stringify({ meta: { code: 200, nbHits: 0, page: 0, nbPages: 0 }, data: [] }) }) });
    expect(await vietnamworksMapper.scan(h.client, input())).toMatchObject({ jobs: [] });
    expect(h.calls).toHaveLength(1);
  });
});
