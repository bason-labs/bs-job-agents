// W5 feed sources: Remote OK, We Work Remotely, Remotive and Jobspresso, read by the orchestrator
// (no bot, no LLM). Parsers run on real responses captured 2026-10-11 (./fixtures, trimmed); the
// scanner on a fake fetch. Covers parsing, canonical URLs, the search profile's filters, the
// time-zone overlap, the USD salary rule, politeness (User-Agent, cache, gap) and failures.
import { readFileSync } from "node:fs";
import { ResearchScanOutputSchema, SEARCH_PROFILE_DEFAULTS, type FeedSource, type SearchProfileFieldsBase } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { openTestDb } from "../db/client.js";
import { dedupeCandidates } from "../db/index.js";
import { fixMojibake } from "./feeds/boards.js";
import {
  FEED_ADAPTERS,
  FEED_USER_AGENT,
  FeedError,
  FeedScanner,
  filterPostings,
  monthlyUsdTop,
  parseRssItems,
  postingRegion,
  regionFits,
  titleLevel,
  type FeedFetch,
  type FeedPosting,
} from "./feeds/index.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const FILES: Record<FeedSource, string> = {
  remoteok: "remoteok-api.json",
  weworkremotely: "weworkremotely-full-stack.rss",
  remotive: "remotive-api.json",
  jobspresso: "jobspresso-feed.rss",
};
const parsed = (source: FeedSource) => FEED_ADAPTERS[source].parse(fixture(FILES[source]));

const criteria = (over: Partial<SearchProfileFieldsBase> = {}): SearchProfileFieldsBase => ({
  ...SEARCH_PROFILE_DEFAULTS,
  workModes: [...SEARCH_PROFILE_DEFAULTS.workModes],
  seniority: ["mid", "senior"],
  sources: ["remoteok", "weworkremotely", "remotive", "jobspresso"],
  languages: ["en"],
  includeKeywords: [],
  excludeKeywords: [],
  excludeCompanies: [],
  companyTypes: [],
  roles: ["Frontend Engineer", "Software Engineer (React/Node)"],
  locations: ["Ho Chi Minh City"],
  ...over,
});

describe("Remote OK (real API response, observed 2026-10-11)", () => {
  it("reads the postings, skips the legal notice, and links back to remoteok.com", () => {
    const jobs = parsed("remoteok");
    expect(jobs).toHaveLength(6);
    expect(jobs.find((j) => j.company === "Lemon.io")).toEqual({
      source: "remoteok",
      url: "https://remoteok.com/remote-jobs/remote-senior-react-full-stack-developer-lemon-io-1137475",
      title: "Senior React Full stack Developer",
      company: "Lemon.io",
      companyWebsite: null,
      regionText: "",
      salaryText: "$80,000 – $200,000 a year",
      postedAt: "2026-10-09T13:09:18.000Z",
      tags: expect.arrayContaining(["react", "node", "full stack"]),
      jdText: expect.stringMatching(/^Are you a talented Senior Developer/),
    });
    expect(jobs.find((j) => j.company === "Bjak")).toMatchObject({ title: "Frontend Engineer", regionText: "Ireland", salaryText: null });
  });

  it("repairs its UTF-8-read-as-Latin-1 text", () => {
    const evolve = parsed("remoteok").find((j) => j.company === "Evolve")!;
    expect(evolve.jdText).toContain("we’re on a mission");
    expect(evolve.jdText).not.toMatch(/â|Â/);
    expect(fixMojibake("Société Générale")).toBe("Société Générale");
    expect(fixMojibake("weâ\u0080\u0099re")).toBe("we’re");
  });

  it("anything but its JSON array is a format error", () => {
    expect(() => FEED_ADAPTERS.remoteok.parse('{"error":"blocked"}')).toThrow(/expected a JSON array/);
  });
});

describe("We Work Remotely (real RSS, observed 2026-10-11)", () => {
  it("splits '<Company>: <Title>' and keeps the region", () => {
    const jobs = parsed("weworkremotely");
    expect(jobs.map((j) => `${j.company} | ${j.title}`)).toEqual([
      "Vercel | Software Engineer, Backend",
      "Maven Clinic | Client Success Manager",
      "Typeform | Full Stack Developer",
      "Lemon.io | Senior React Full-stack Developer",
      "Sticker Mule | AI agent engineer",
      "Sticker Mule | Software engineer",
    ]);
    expect(jobs[0]).toMatchObject({
      url: "https://weworkremotely.com/remote-jobs/vercel-software-engineer-backend",
      regionText: "Anywhere in the World",
      postedAt: "2026-10-11T07:31:07.000Z",
      tags: ["full-stack programming", "full-time"],
    });
    expect(jobs[0]!.jdText).toMatch(/^Headquarters: Remote - United States\nAbout Vercel:/);
    expect(jobs[3]!.regionText).toMatch(/^Anywhere in the World · .*Viet Nam/);
  });

  it("reads one feed per programming category", () => {
    expect(FEED_ADAPTERS.weworkremotely.requests(criteria()).map((r) => r.url)).toEqual([
      "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
      "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss",
      "https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss",
    ]);
    expect(() => FEED_ADAPTERS.weworkremotely.parse("<html><title>Just a moment...</title></html>")).toThrow(/expected an RSS feed/);
  });
});

describe("Remotive (real API response, observed 2026-10-11)", () => {
  it("reads jobs with their required location and salary; dates are UTC", () => {
    const jobs = parsed("remotive");
    expect(jobs).toHaveLength(6);
    expect(jobs.find((j) => j.title === "Frontend Web Application Developer")).toMatchObject({
      url: "https://remotive.com/remote-jobs/design/frontend-web-application-developer-2091141",
      company: "KoboToolbox",
      regionText: "USA, Canada, Argentina, Mexico, Peru",
      salaryText: "$90k - $105k",
      postedAt: "2026-09-18T16:43:22.000Z",
    });
  });

  it("one request per scan (Remotive asks for ≤ 4 calls a day), cached 6 h", () => {
    expect(FEED_ADAPTERS.remotive.requests(criteria())).toEqual([{ url: "https://remotive.com/api/remote-jobs?category=software-dev&limit=100", format: "json" }]);
    expect(FEED_ADAPTERS.remotive.cacheTtlMs).toBe(6 * 3_600_000);
  });
});

describe("Jobspresso (real RSS, observed 2026-10-11)", () => {
  it("reads company and location from job_listing:*, the full JD from content:encoded", () => {
    const jobs = parsed("jobspresso");
    expect(jobs.map((j) => [j.company, j.title, j.regionText])).toEqual([
      ["Hopper", "Senior Full Stack Engineer, Realtime & Voice", "Canada"],
      ["The Athletic", "Senior Product Designer", "United States"],
      ["Samsara", "Staff Software Engineer", "Canada"],
      ["Grafana Labs", "Senior Software Engineer – k6 Core", "United States (EST Time Zone)"],
    ]);
    expect(jobs[0]).toMatchObject({ url: "https://jobspresso.co/job/senior-full-stack-engineer-realtime-voice", postedAt: "2026-08-29T02:11:11.000Z" });
    expect(jobs[0]!.jdText.length).toBeGreaterThan(1000);
  });

  it("searches per role (at most 3), 30 per page", () => {
    const urls = FEED_ADAPTERS.jobspresso.requests(criteria({ roles: ["Frontend Engineer", "Software Engineer (React/Node)", "Fullstack", "Backend"] })).map((r) => r.url);
    expect(urls).toEqual([
      "https://jobspresso.co/?feed=job_feed&search_keywords=Frontend+Engineer&posts_per_page=30",
      "https://jobspresso.co/?feed=job_feed&search_keywords=Software+Engineer&posts_per_page=30",
      "https://jobspresso.co/?feed=job_feed&search_keywords=Fullstack&posts_per_page=30",
    ]);
  });

  it("parseRssItems: CDATA, entities, namespaced and self-closing elements", () => {
    const items = parseRssItems(
      `<rss><channel><item><title>A &amp; B &#8211; C</title><dc:creator><![CDATA[Acme<br>x]]></dc:creator><media:content url="x"/><link>https://x.example/j/1</link></item></channel></rss>`,
    );
    expect(items).toEqual([{ title: "A & B – C", "dc:creator": "Acme<br>x", "media:content": "", link: "https://x.example/j/1" }]);
  });
});

describe("the search profile's filters (code, before any LLM)", () => {
  const all = (): FeedPosting[] => (Object.keys(FILES) as FeedSource[]).flatMap(parsed);

  it("roles, seniority and the generic 'Software Engineer (React/Node)' role", () => {
    const { kept, dropped } = filterPostings(all(), criteria());
    expect(kept.map((p) => `${p.source}: ${p.company} – ${p.title}`).sort()).toEqual([
      "remoteok: Bjak – Frontend Engineer",
      "remoteok: Lemon.io – Senior React Full stack Developer",
      "remoteok: Sanctuary Computer – Senior Shopify Developer",
      "remotive: KoboToolbox – Frontend Web Application Developer",
      "remotive: Lemon.io – Senior React Full-stack Developer",
      "remotive: Lemon.io – Senior back-end Engineer",
      "remotive: Sanctuary Computer Inc – Senior Shopify Developer",
      "weworkremotely: Lemon.io – Senior React Full-stack Developer",
      "weworkremotely: Sticker Mule – Software engineer",
      "weworkremotely: Vercel – Software Engineer, Backend",
      "jobspresso: Hopper – Senior Full Stack Engineer, Realtime & Voice",
    ].sort());
    const why = Object.fromEntries(dropped.map((d) => [`${d.posting.company} – ${d.posting.title}`, d.reason]));
    expect(why).toMatchObject({
      "Maven Clinic – Client Success Manager": "role",
      "Credit Wellness, LLC – Inside Sales Contractor": "role",
      "Samsara – Staff Software Engineer": "role",
      "Evolve – Staff Software Engineer": "role",
      "The Athletic – Senior Product Designer": "role",
      // "Software Engineer (React/Node)": a generic dev title, but React or Node nowhere in the posting.
      "Sticker Mule – AI agent engineer": "role",
      "Grafana Labs – Senior Software Engineer – k6 Core": "role",
    });
    // With a plain "Software Engineer" role, the Staff titles are left out for their level.
    const plain = filterPostings(all(), criteria({ roles: ["Software Engineer"] }));
    expect(plain.dropped.filter((d) => d.reason === "seniority").map((d) => d.posting.company).sort()).toEqual(["Evolve", "Samsara"]);
    expect(plain.kept.map((p) => p.company)).toContain("Grafana Labs");
  });

  it("must-include keywords (any one), excluded keywords and companies", () => {
    const kept = (over: Partial<SearchProfileFieldsBase>) => filterPostings(all(), criteria(over)).kept.map((p) => `${p.source}: ${p.title}`);
    const shopify = kept({ includeKeywords: ["Shopify"] });
    expect(shopify).toEqual(expect.arrayContaining(["remoteok: Senior Shopify Developer", "remotive: Senior Shopify Developer"]));
    // Any one keyword anywhere in the posting: Bjak's frontend role never says Shopify.
    expect(shopify).not.toContain("remoteok: Frontend Engineer");
    expect(kept({ includeKeywords: ["Shopify", "GraphQL"] })).toContain("remoteok: Frontend Engineer");
    expect(kept({ excludeKeywords: ["Shopify"] })).not.toContain("remoteok: Senior Shopify Developer");
    expect(kept({ excludeCompanies: ["lemon.io"] }).some((k) => k.includes("Senior React Full"))).toBe(false);
  });

  it("time-zone overlap: worldwide, Vietnam and unknown regions stay; clearly elsewhere goes", () => {
    const remote = (over: Partial<SearchProfileFieldsBase>) => filterPostings(all(), criteria(over));
    const asia = remote({ timezoneOverlap: "UTC+7 ±3h" });
    const titles = asia.kept.map((p) => `${p.source}: ${p.company}`);
    expect(titles).toContain("weworkremotely: Lemon.io"); // Anywhere in the World (… Viet Nam …)
    expect(titles).toContain("remotive: Lemon.io"); // Europe, USA, Canada, APAC
    expect(titles).toContain("remoteok: Lemon.io"); // no region stated
    expect(titles).toContain("remotive: Sanctuary Computer Inc"); // Worldwide
    expect(asia.dropped.filter((d) => d.reason === "region").map((d) => `${d.posting.source}: ${d.posting.company}`).sort()).toEqual([
      "jobspresso: Hopper", // Canada
      "remoteok: Bjak", // Ireland
      "remotive: KoboToolbox", // USA, Canada, Argentina, Mexico, Peru
    ]);
    expect(remote({ timezoneOverlap: null }).dropped.some((d) => d.reason === "region")).toBe(false);
  });

  it("regions as the boards write them", () => {
    const asia = { from: 4, to: 10 };
    expect(regionFits("Anywhere in the World", asia)).toBe(true);
    expect(regionFits("Worldwide", asia)).toBe(true);
    expect(regionFits("France, Japan, Turkey, Vietnam, Mexico, Norway", asia)).toBe(true);
    expect(regionFits("", asia)).toBe(true);
    expect(regionFits("Remoto", asia)).toBe(true);
    expect(regionFits("USA Only", asia)).toBe(false);
    expect(regionFits("Remote - US", asia)).toBe(false);
    expect(regionFits("Various US States", asia)).toBe(false);
    expect(regionFits("Europe", asia)).toBe(false);
    expect(regionFits("Europe", { from: 0, to: 3 })).toBe(true);
    expect(regionFits("UTC-3 to UTC+3", asia)).toBe(false);
    expect(regionFits("UTC+5 to UTC+9", asia)).toBe(true);
    expect(regionFits("Europe, USA, UK, Canada, Australia, Singapore", asia)).toBe(true);
    expect(regionFits("USA", null)).toBe(true);
    expect(postingRegion("United States (EST Time Zone)").ranges).toEqual([{ from: -8, to: -3 }]);
  });

  it("titles that name a level", () => {
    expect(titleLevel("Senior Frontend Engineer")).toBe("senior");
    expect(titleLevel("Sr. React Developer")).toBe("senior");
    expect(titleLevel("Staff Software Engineer")).toBe("lead");
    expect(titleLevel("Lead Engineer")).toBe("lead");
    expect(titleLevel("Junior Developer")).toBe("junior");
    expect(titleLevel("Software Engineering Intern")).toBe("intern");
    expect(titleLevel("Frontend Engineer")).toBeNull();
  });

  it("salary in USD per month: yearly ÷ 12, hourly × 160; other currencies and no amount are not compared", () => {
    expect(monthlyUsdTop("$80,000 – $200,000 a year")).toBe(16_667);
    expect(monthlyUsdTop("$90k - $105k")).toBe(8_750);
    expect(monthlyUsdTop("$45-$120/Hour")).toBe(19_200);
    expect(monthlyUsdTop("$3,000 / month")).toBe(3_000);
    expect(monthlyUsdTop("€60k - €80k")).toBeNull();
    expect(monthlyUsdTop("Competitive")).toBeNull();
    expect(monthlyUsdTop(null)).toBeNull();
    expect(monthlyUsdTop("$200")).toBeNull(); // no period, too small to be yearly: not compared
  });

  it("the USD minimum drops only postings whose top is under it; a VND minimum is not compared", () => {
    const usd = filterPostings(all(), criteria({ minSalary: 9_000, currency: "USD" }));
    expect(usd.dropped.filter((d) => d.reason === "salary").map((d) => `${d.posting.source}: ${d.posting.title}`)).toEqual(["remotive: Frontend Web Application Developer"]);
    // Postings without a salary stay.
    expect(usd.kept.some((p) => p.salaryText === null)).toBe(true);
    const vnd = filterPostings(all(), criteria({ minSalary: 250_000_000, currency: "VND" }));
    expect(vnd.dropped.some((d) => d.reason === "salary")).toBe(false);
  });
});

/** A fake fetch serving the fixtures by URL. */
function fakeFetch(overrides: Record<string, () => Promise<{ ok: boolean; status: number; text(): Promise<string> }>> = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn: FeedFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const override = Object.entries(overrides).find(([prefix]) => url.startsWith(prefix));
    if (override) return override[1]();
    const file = url.startsWith("https://remoteok.com/")
      ? FILES.remoteok
      : url.startsWith("https://weworkremotely.com/")
        ? FILES.weworkremotely
        : url.startsWith("https://remotive.com/")
          ? FILES.remotive
          : url.startsWith("https://jobspresso.co/")
            ? FILES.jobspresso
            : null;
    if (!file) return { ok: false, status: 404, text: async () => "" };
    const body = fixture(file);
    return { ok: true, status: 200, text: async () => body };
  };
  return { fn, calls };
}

describe("FeedScanner (no bot, no LLM)", () => {
  const input = { criteria: criteria(), candidateLimit: 15 };

  it("answers in research.scan's output shape: Remote, remote work mode, newest first, no page views", async () => {
    const { fn, calls } = fakeFetch();
    const scanner = new FeedScanner({ fetch: fn, sleep: async () => undefined });
    const out = await scanner.scan("remoteok", input);
    expect(ResearchScanOutputSchema.safeParse(out).success).toBe(true);
    expect(out.pageViews).toBe(0);
    expect(out.blocked).toBeNull();
    expect(out.jobs.map((j) => j.title)).toEqual(["Senior React Full stack Developer", "Frontend Engineer", "Senior Shopify Developer"]);
    expect(out.jobs[0]).toMatchObject({ source: "remoteok", location: "Remote", workMode: "remote", language: "en", url: "https://remoteok.com/remote-jobs/remote-senior-react-full-stack-developer-lemon-io-1137475" });
    expect(out.jobs[1]!.jdText).toMatch(/^Remote region: Ireland\n/);
    expect(out.selfCheck).toEqual([
      { item: "Read the Remote OK feed directly (no bot, no LLM)", passed: true, note: "6 postings, 3 fit the search criteria (left out: 3 not one of the roles); 1 request sent" },
    ]);
    expect(calls).toEqual([{ url: "https://remoteok.com/api", headers: expect.objectContaining({ "User-Agent": FEED_USER_AGENT }) }]);
  });

  it("caps each source at the scan's candidate limit, keeping the newest", async () => {
    const { fn } = fakeFetch();
    const out = await new FeedScanner({ fetch: fn, sleep: async () => undefined }).scan("remoteok", { criteria: criteria(), candidateLimit: 2 });
    expect(out.jobs.map((j) => j.postedAt)).toEqual(["2026-10-09T13:09:18.000Z", "2026-09-20T00:00:25.000Z"]);
    expect(out.selfCheck[0]!.note).toMatch(/the newest 2 kept/);
  });

  it("is polite: one board's requests wait their turn with a gap, and responses are cached", async () => {
    let clock = 1_000_000;
    const sleeps: number[] = [];
    const { fn, calls } = fakeFetch();
    const scanner = new FeedScanner({
      fetch: fn,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += Math.max(0, ms);
      },
      minGapMs: 1_500,
    });
    const first = await scanner.scan("weworkremotely", input);
    expect(calls.map((c) => c.url)).toHaveLength(3);
    expect(sleeps.filter((ms) => ms > 0)).toEqual([1_500, 1_500]);
    // The same posting in two category feeds is listed once.
    expect(new Set(first.jobs.map((j) => j.url)).size).toBe(first.jobs.length);
    expect(first.selfCheck[0]!.note).toMatch(/3 requests sent/);

    clock += 30 * 60_000;
    const again = await scanner.scan("weworkremotely", input);
    expect(calls).toHaveLength(3);
    expect(again.selfCheck[0]!.note).toMatch(/0 requests sent/);

    clock += 31 * 60_000;
    await scanner.scan("weworkremotely", input);
    expect(calls).toHaveLength(6);
  });

  it("a failed request fails the source with a clear message (the scan's join goes on without it)", async () => {
    const http = fakeFetch({ "https://remotive.com/": async () => ({ ok: false, status: 429, text: async () => "slow down" }) });
    await expect(new FeedScanner({ fetch: http.fn, sleep: async () => undefined }).scan("remotive", input)).rejects.toThrow(
      new FeedError("remotive", "Remotive: https://remotive.com/api/remote-jobs?category=software-dev&limit=100 answered HTTP 429 (rate limited: try again later)"),
    );
    const down = fakeFetch({ "https://remoteok.com/": () => Promise.reject(new TypeError("fetch failed")) });
    await expect(new FeedScanner({ fetch: down.fn, sleep: async () => undefined }).scan("remoteok", input)).rejects.toThrow(/Remote OK: could not reach https:\/\/remoteok.com\/api \(fetch failed\)/);
    const html = fakeFetch({ "https://jobspresso.co/": async () => ({ ok: true, status: 200, text: async () => "<html>maintenance</html>" }) });
    await expect(new FeedScanner({ fetch: html.fn, sleep: async () => undefined }).scan("jobspresso", input)).rejects.toThrow(/Jobspresso: the feed at .* could not be read \(Jobspresso: expected an RSS feed\)/);
  });

  it("times out a request that never answers, and stops when the task is cancelled", async () => {
    const never: FeedFetch = (_url, init) =>
      new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    await expect(new FeedScanner({ fetch: never, sleep: async () => undefined, timeoutMs: 30 }).scan("remoteok", input)).rejects.toThrow(/Remote OK: could not reach .* \(no answer within 0 s\)/);
    const cancel = new AbortController();
    const pending = new FeedScanner({ fetch: never, sleep: async () => undefined }).scan("remoteok", input, cancel.signal);
    cancel.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });
});

describe("dedupe across sources (UC-04)", () => {
  it("the same Lemon.io job on Remote OK, We Work Remotely and Remotive is stored once", async () => {
    const { fn } = fakeFetch();
    const scanner = new FeedScanner({ fetch: fn, sleep: async () => undefined });
    const outs = await Promise.all((["remoteok", "weworkremotely", "remotive"] as const).map((s) => scanner.scan(s, { criteria: criteria(), candidateLimit: 30 })));
    const lemon = outs.flatMap((o) => o.jobs).filter((j) => j.company === "Lemon.io" && /react full/i.test(j.title));
    expect(lemon.map((j) => j.source)).toEqual(["remoteok", "weworkremotely", "remotive"]);
    const db = openTestDb();
    const r = dedupeCandidates(db, lemon);
    expect(r.fresh).toHaveLength(1);
    expect(r.fresh[0]).toMatchObject({ source: "remoteok", location: "Remote" });
    expect(r.duplicates.map((d) => d.matchedBy)).toEqual(["dedupe_hash", "dedupe_hash"]);
  });
});
