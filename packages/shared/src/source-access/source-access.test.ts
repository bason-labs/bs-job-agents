// API research (design 2026-10-19 §5.1, spec REQ-21, REQ-22, NFR-2): one access record per board
// decides how it is read: public API, then account API, then browser.
import { describe, expect, it } from "vitest";
import { SearchSourceSchema } from "../common/primitives.js";
import { FEED_SOURCES, SEARCH_SOURCES } from "../common/sources.js";
import {
  ACCESS_LABELS,
  ACCESS_LABEL_HINTS,
  BOARD_SOURCES,
  SourceAccessRecordSchema,
  accessPathOf,
  accessPathOfSource,
  accessStateOf,
  internalPostSearchEndpoints,
  sourceAccessRecord,
  sourceAccessRecords,
  unresearchedRecord,
  type PostSearchEndpoint,
  type SourceAccessRecord,
} from "./index.js";

const GET = { method: "GET", host: "itviec.com", pathPattern: "/api/v1/jobs", purpose: "search", requiresAuth: true } as const;

/** A complete record: no public API, one internal GET endpoint, terms and risk filled in. */
function record(over: Partial<SourceAccessRecord> = {}): SourceAccessRecord {
  return SourceAccessRecordSchema.parse({
    source: "itviec",
    researchedAt: "2026-10-19T08:00:00.000Z",
    publicApi: "none found",
    internalApiGetEndpoints: [GET, { ...GET, pathPattern: "/api/v1/jobs/:id", purpose: "detail" }],
    applyEndpoints: [{ ...GET, method: "POST", pathPattern: "/api/v1/jobs/:id/apply", purpose: "other", documentedOnly: true }],
    auth: { kind: "cookie", names: ["_itviec_session"], howToCopy: "DevTools → Application → Cookies → itviec.com" },
    termsOfUse: { url: "https://itviec.com/terms", clauses: ["You may not scrape the site."] },
    accountRisk: "Low: the site rate-limits but has not restricted accounts.",
    riskLevel: "low",
    chosenPath: "account_api",
    ...over,
  });
}

describe("SourceAccessRecordSchema", () => {
  it("reads the researcher's JSON shape, 'none found' included (REQ-22.AC-1)", () => {
    const r = record({ internalApiGetEndpoints: "none found", applyEndpoints: "none found", chosenPath: "browser" });
    expect(r.publicApi).toBe("none found");
    expect(r.internalApiGetEndpoints).toBe("none found");
  });

  it("an apply endpoint must be documentedOnly: true (REQ-22.AC-2)", () => {
    const bad = { ...record(), applyEndpoints: [{ ...GET, documentedOnly: false }] };
    expect(SourceAccessRecordSchema.safeParse(bad).success).toBe(false);
  });

  it("a GET endpoint list holds GET only", () => {
    const bad = { ...record(), internalApiGetEndpoints: [{ ...GET, method: "POST" }] };
    expect(SourceAccessRecordSchema.safeParse(bad).success).toBe(false);
  });
});

describe("PostSearchEndpointSchema (2026-10-20 addendum)", () => {
  const POST: PostSearchEndpoint = {
    method: "POST",
    host: "ms.itviec.com",
    pathPattern: "/search",
    purpose: "search",
    requiresAuth: false,
    readOnly: true,
    contentType: "application/json",
    headers: { "X-Source": "Page-Container" },
    bodyKeys: ["query", "page"],
    filterFields: [],
    orderFields: [],
    retrieveFields: ["jobId"],
    maxPageSize: 50,
  };

  it("a read-only POST search beside a GET detail parses; the access path still comes from the GET list", () => {
    const r = record({ internalApiPostSearchEndpoints: [POST] });
    expect(internalPostSearchEndpoints(r)).toHaveLength(1);
    expect(accessPathOf(r, { approved: false })).toBe("account_api");
    expect(internalPostSearchEndpoints(record())).toEqual([]);
  });

  it("a POST search alone (no GET detail endpoint) is refused", () => {
    const searchOnly = { ...record(), internalApiGetEndpoints: [GET], internalApiPostSearchEndpoints: [POST] };
    expect(SourceAccessRecordSchema.safeParse(searchOnly).success).toBe(false);
    expect(SourceAccessRecordSchema.safeParse({ ...record(), internalApiGetEndpoints: "none found", internalApiPostSearchEndpoints: [POST] }).success).toBe(false);
  });

  it("only a read-only, no-auth, JSON search: any other purpose, auth, content type or an unknown key is refused", () => {
    const bad = [
      { ...POST, purpose: "detail" },
      { ...POST, purpose: "other" },
      { ...POST, requiresAuth: true },
      { ...POST, readOnly: false },
      { ...POST, contentType: "application/x-www-form-urlencoded" },
      { ...POST, method: "PUT" },
      { ...POST, maxPageSize: 0 },
      { ...POST, bodyKeys: [] },
      { ...POST, documentedOnly: true },
    ];
    for (const p of bad) expect(SourceAccessRecordSchema.safeParse({ ...record(), internalApiPostSearchEndpoints: [p] }).success, JSON.stringify(p)).toBe(false);
  });
});

describe("accessPathOf (REQ-21)", () => {
  const publicApi = { usable: true, needsDeveloperKey: false, endpoints: [{ ...GET, host: "api.itviec.com", requiresAuth: false }] };

  it("a usable public API wins over the account API (REQ-21.AC-1)", () => {
    expect(accessPathOf(record({ publicApi }), { approved: false })).toBe("public_api");
  });

  it("no public API but an internal GET endpoint, terms and risk: account API (REQ-21.AC-2)", () => {
    expect(accessPathOf(record(), { approved: false })).toBe("account_api");
  });

  it("neither: browser (REQ-21.AC-3, REQ-22.AC-4)", () => {
    expect(accessPathOf(record({ internalApiGetEndpoints: "none found" }), { approved: true })).toBe("browser");
  });

  it("a public API that needs a developer key or is unusable falls through", () => {
    expect(accessPathOf(record({ publicApi: { ...publicApi, needsDeveloperKey: true } }), { approved: false })).toBe("account_api");
    expect(accessPathOf(record({ publicApi: { ...publicApi, usable: false } }), { approved: false })).toBe("account_api");
    expect(accessPathOf(record({ publicApi: { ...publicApi, endpoints: [] }, internalApiGetEndpoints: "none found" }), { approved: false })).toBe("browser");
  });

  it("an empty risk statement or no terms clauses: browser (NFR-2)", () => {
    expect(accessPathOf(record({ accountRisk: "  " }), { approved: true })).toBe("browser");
    expect(accessPathOf(record({ termsOfUse: { url: "https://itviec.com/terms", clauses: [] } }), { approved: true })).toBe("browser");
  });

  it("a high-risk board needs Ba's approval before the account API (decision 2)", () => {
    const high = record({ riskLevel: "high", chosenPath: "account_api" });
    expect(accessPathOf(high, { approved: false })).toBe("browser");
    expect(accessPathOf(high, { approved: true })).toBe("account_api");
  });
});

describe("accessStateOf (what the Search criteria screen shows)", () => {
  it("a high-risk board not approved: browser, needs approval", () => {
    const s = accessStateOf(record({ riskLevel: "high" }), { approved: false, tokenPresent: true });
    expect(s).toEqual({ path: "browser", needsApproval: true, tokenMissing: false, labelKey: "account_api_needs_approval" });
  });

  it("an account-API board with no token: token missing", () => {
    expect(accessStateOf(record(), { approved: false, tokenPresent: false })).toEqual({ path: "account_api", needsApproval: false, tokenMissing: true, labelKey: "account_api_token_missing" });
  });

  it("plain paths", () => {
    expect(accessStateOf(record(), { approved: false, tokenPresent: true }).labelKey).toBe("account_api");
    expect(accessStateOf(record({ internalApiGetEndpoints: "none found" }), { approved: false, tokenPresent: false })).toEqual({ path: "browser", needsApproval: false, tokenMissing: false, labelKey: "browser" });
  });

  it("an account-API board read without login (auth none): Direct (no login), never token missing", () => {
    const noLogin = record({ auth: { kind: "none", names: [], howToCopy: "" } });
    expect(accessStateOf(noLogin, { approved: false, tokenPresent: false })).toEqual({ path: "account_api", needsApproval: false, tokenMissing: false, labelKey: "account_api_direct" });
    expect(accessStateOf(noLogin, { approved: false, tokenPresent: true }).labelKey).toBe("account_api_direct");
  });

  it("a high-risk no-login board still needs approval first, worded as a direct read (no account involved)", () => {
    const s = accessStateOf(record({ riskLevel: "high", auth: { kind: "none", names: [], howToCopy: "" } }), { approved: false, tokenPresent: false });
    expect(s).toEqual({ path: "browser", needsApproval: true, tokenMissing: false, labelKey: "direct_needs_approval" });
  });

  it("the label set, with a browser hint where the label alone would mislead", () => {
    expect(Object.values(ACCESS_LABELS)).toEqual(["Public API", "Direct (no login)", "Account API", "Account API (needs approval)", "Direct read (needs approval)", "Account API (token missing)", "Browser"]);
    expect(ACCESS_LABEL_HINTS).toEqual({ account_api_needs_approval: "Browser until approved", direct_needs_approval: "Browser until approved", account_api_token_missing: "Browser until a token is set" });
  });

  it("the researched TopCV and ITviec records read as Direct (no login)", () => {
    for (const s of ["topcv", "itviec"] as const) {
      const r = sourceAccessRecord(s);
      if (r.chosenPath !== "account_api" || r.auth.kind !== "none" || r.riskLevel !== "low") continue; // research may change
      expect(accessStateOf(r, { approved: false, tokenPresent: false }).labelKey, s).toBe("account_api_direct");
    }
  });
});

describe("the six board records", () => {
  it("one per non-feed source; the feeds are public_api by construction", () => {
    expect([...BOARD_SOURCES].sort()).toEqual(SearchSourceSchema.options.filter((s) => !FEED_SOURCES.includes(s as never)).sort());
    for (const s of FEED_SOURCES) expect(accessPathOfSource(s, { approved: false })).toBe("public_api");
    for (const s of BOARD_SOURCES) expect(sourceAccessRecord(s).source).toBe(s);
  });

  it("every record parses and its chosenPath equals accessPathOf with every board approved", () => {
    for (const r of sourceAccessRecords()) {
      expect(SourceAccessRecordSchema.safeParse(r).success).toBe(true);
      expect(r.chosenPath, r.source).toBe(accessPathOf(r, { approved: true }));
    }
  });

  it("an account-API record lists a GET endpoint and a non-empty risk statement (REQ-22.AC-3)", () => {
    for (const r of sourceAccessRecords().filter((x) => x.chosenPath === "account_api")) {
      expect(Array.isArray(r.internalApiGetEndpoints) && r.internalApiGetEndpoints.length > 0).toBe(true);
      expect(r.accountRisk.trim()).not.toBe("");
    }
  });

  it("all six researched records are wired in (none is the unresearched placeholder)", () => {
    for (const r of sourceAccessRecords()) expect(r.researchedAt, r.source).not.toBe("unresearched");
  });

  it("LinkedIn (2026-10-20): the two jobs-guest GETs only, no voyager endpoint, no login; high risk, so it needs Ba's approval", () => {
    const r = sourceAccessRecord("linkedin");
    expect(r.researchedAt).toBe("2026-10-20");
    expect(r.auth).toEqual({ kind: "none", names: [], howToCopy: expect.any(String) });
    const gets = Array.isArray(r.internalApiGetEndpoints) ? r.internalApiGetEndpoints : [];
    expect(gets.map((e) => [e.method, e.host, e.pathPattern, e.purpose, e.requiresAuth])).toEqual([
      ["GET", "www.linkedin.com", "/jobs-guest/jobs/api/seeMoreJobPostings/search", "search", false],
      ["GET", "www.linkedin.com", "/jobs-guest/jobs/api/jobPosting/:jobId(digits)", "detail", false],
    ]);
    expect(gets[0]!.query).toEqual(["keywords", "location", "f_TPR", "start"]);
    expect(JSON.stringify(r)).not.toMatch(/voyager\/api/);
    expect(r.termsOfUse.clauses.some((c) => /scrape/.test(c))).toBe(true);
    expect(r.accountRisk).toMatch(/robots\.txt/);
    expect(r.riskLevel).toBe("high");
    expect(accessStateOf(r, { approved: false, tokenPresent: false })).toEqual({ path: "browser", needsApproval: true, tokenMissing: false, labelKey: "direct_needs_approval" });
    expect(accessStateOf(r, { approved: true, tokenPresent: false })).toEqual({ path: "account_api", needsApproval: false, tokenMissing: false, labelKey: "account_api_direct" });
  });

  it("VietnamWorks (2026-10-20): a read-only POST search and a GET job page, no login, low risk: Direct (no login) without approval", () => {
    const r = sourceAccessRecord("vietnamworks");
    expect(r.researchedAt).toBe("2026-10-20");
    expect(r.auth.kind).toBe("none");
    const [post] = internalPostSearchEndpoints(r);
    expect(post).toMatchObject({ method: "POST", host: "ms.vietnamworks.com", pathPattern: "/job-search/v1.0/search", readOnly: true, requiresAuth: false, maxPageSize: 50 });
    expect(post!.filterFields).toContain("workingLocations.cityId");
    expect(r.termsOfUse.clauses).toEqual(["No clause on bots or automated access found (checked 2026-10-20)"]);
    expect(r).toMatchObject({ riskLevel: "low", chosenPath: "account_api" });
    expect(accessStateOf(r, { approved: false, tokenPresent: false }).labelKey).toBe("account_api_direct");
  });

  it("an unresearched board is read in the browser", () => {
    const r = unresearchedRecord("linkedin");
    expect(accessPathOf(r, { approved: true })).toBe("browser");
    expect(r.chosenPath).toBe("browser");
  });

  it("feeds keep kind 'feed'; boards keep kind 'browser' (the kind is the fetcher, the path comes from accessPathOf)", () => {
    for (const s of BOARD_SOURCES) expect(SEARCH_SOURCES[s].kind).toBe("browser");
  });
});
