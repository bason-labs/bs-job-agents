// AD-2 (REQ-23, NFR-1): every board-API request goes through BoardApiClient, built from the board's
// access record. Anything but a listed GET endpoint throws EndpointNotAllowed before fetch is called.
import { SourceAccessRecordSchema, applyEndpointsOf, sourceAccessRecords, type SourceAccessRecord } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { HostGate, type HttpFetch } from "../http/index.js";
import { Redactor } from "../secrets/index.js";
import { AuthRejected, BoardApiClient, BoardApiError, EndpointNotAllowed, MissingCredential, matchesPathPattern, type RecordedRequest } from "./client.js";

const LI_AT = "AQEDAR-li-at-secret-value";
const CSRF = "ajax:9876543210";

const linkedin: SourceAccessRecord = SourceAccessRecordSchema.parse({
  source: "linkedin",
  researchedAt: "2026-10-19T08:00:00.000Z",
  publicApi: "none found",
  internalApiGetEndpoints: [
    { method: "GET", host: "www.linkedin.com", pathPattern: "/voyager/api/voyagerJobsDashJobCards", query: ["keywords", "start"], purpose: "search", requiresAuth: true },
    { method: "GET", host: "www.linkedin.com", pathPattern: "/voyager/api/jobs/jobPostings/:id", purpose: "detail", requiresAuth: true },
  ],
  applyEndpoints: [
    { method: "POST", host: "www.linkedin.com", pathPattern: "/voyager/api/jobs/easyApply/:id", purpose: "other", requiresAuth: true, documentedOnly: true },
    { method: "GET", host: "www.linkedin.com", pathPattern: "/voyager/api/jobs/jobPostings/:id/apply", purpose: "other", requiresAuth: true, documentedOnly: true },
  ],
  auth: { kind: "cookie+header", names: ["li_at", "header:csrf-token"], howToCopy: "DevTools" },
  termsOfUse: { url: "https://www.linkedin.com/legal/user-agreement", clauses: ["No bots."] },
  accountRisk: "High: accounts are restricted for automation.",
  riskLevel: "high",
  chosenPath: "account_api",
});

function fakeFetch(answer: (url: string) => { status: number; body?: string } = () => ({ status: 200, body: "{}" })) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn: HttpFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const a = answer(url);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => a.body ?? "" };
  };
  return { fn, calls };
}

function client(opts: { fetch?: HttpFetch; credentials?: Record<string, string> | null; record?: SourceAccessRecord; redactor?: Redactor } = {}) {
  const requests: RecordedRequest[] = [];
  let now = 1_000_000;
  const gate = new HostGate({ now: () => now, sleep: async (ms) => void (now += Math.max(0, ms)) });
  const c = new BoardApiClient({
    record: opts.record ?? linkedin,
    path: "account_api",
    fetch: opts.fetch ?? fakeFetch().fn,
    gate,
    credentials: opts.credentials === undefined ? { li_at: LI_AT, "csrf-token": CSRF } : opts.credentials,
    redactor: opts.redactor ?? new Redactor(),
    onRequest: (r) => requests.push(r),
  });
  return { c, requests, clock: () => now };
}

describe("matchesPathPattern", () => {
  it("':name' matches one non-empty piece of a segment", () => {
    expect(matchesPathPattern("/v1/jobs/:id", "/v1/jobs/42")).toBe(true);
    expect(matchesPathPattern("/v1/jobs/:id", "/v1/jobs/42/apply")).toBe(false);
    expect(matchesPathPattern("/v1/jobs/:id", "/v1/jobs/")).toBe(false);
    expect(matchesPathPattern("/tim-viec-lam-:role-tai-:city", "/tim-viec-lam-react-tai-ha-noi")).toBe(true);
    expect(matchesPathPattern("/viec-lam/:slug/:id.html", "/viec-lam/dev/123.html")).toBe(true);
    expect(matchesPathPattern("/viec-lam/:slug/:id.html", "/viec-lam/dev/123xhtml")).toBe(false);
  });
});

describe("BoardApiClient", () => {
  it("an unlisted endpoint throws EndpointNotAllowed before fetch is called", async () => {
    const f = fakeFetch();
    const { c } = client({ fetch: f.fn });
    await expect(c.get({ host: "www.linkedin.com", path: "/voyager/api/me" })).rejects.toThrow(EndpointNotAllowed);
    await expect(c.get({ host: "evil.example", path: "/voyager/api/voyagerJobsDashJobCards" })).rejects.toThrow(EndpointNotAllowed);
    expect(f.calls).toHaveLength(0);
  });

  it("a query parameter the endpoint does not list throws EndpointNotAllowed before fetch is called", async () => {
    const f = fakeFetch();
    const { c } = client({ fetch: f.fn });
    // The search endpoint takes keywords and start only; the detail endpoint lists no query at all.
    await expect(c.get({ host: "www.linkedin.com", path: "/voyager/api/voyagerJobsDashJobCards", query: { keywords: "react", count: 100 } })).rejects.toThrow(
      /with query parameters keywords, count/,
    );
    await expect(c.get({ host: "www.linkedin.com", path: "/voyager/api/jobs/jobPostings/1", query: { decorationId: "x" } })).rejects.toThrow(EndpointNotAllowed);
    expect(f.calls).toHaveLength(0);
    await c.get({ host: "www.linkedin.com", path: "/voyager/api/voyagerJobsDashJobCards", query: { keywords: "react" } });
    expect(f.calls).toHaveLength(1);
  });

  it("when two endpoints match a path, the one listing the query names allows it (ITviec search and detail share /it-jobs/:x)", async () => {
    const f = fakeFetch();
    const { c } = client({ fetch: f.fn, record: sourceAccessRecords().find((r) => r.source === "itviec")!, credentials: null });
    await c.get({ host: "itviec.com", path: "/it-jobs/react-developer", query: { page: 2 } });
    await c.get({ host: "itviec.com", path: "/it-jobs/fintech-frontend-dev-javascript-react-new-wealth-2706" });
    await expect(c.get({ host: "itviec.com", path: "/it-jobs/react-developer", query: { sort: "new" } })).rejects.toThrow(EndpointNotAllowed);
    expect(f.calls.map((x) => x.url)).toEqual(["https://itviec.com/it-jobs/react-developer?page=2", "https://itviec.com/it-jobs/fintech-frontend-dev-javascript-react-new-wealth-2706"]);
  });

  it("every apply endpoint of this record and of every real record throws before fetch (REQ-23.AC-1)", async () => {
    const f = fakeFetch();
    for (const record of [linkedin, ...sourceAccessRecords()]) {
      const { c } = client({ fetch: f.fn, record });
      for (const e of applyEndpointsOf(record)) {
        const path = e.pathPattern.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "123");
        await expect(c.get({ host: e.host, path }), `${record.source} ${e.pathPattern}`).rejects.toThrow(EndpointNotAllowed);
      }
    }
    expect(f.calls).toHaveLength(0);
  });

  it("sends the credentials (cookie + header) and records method, host and path only", async () => {
    const f = fakeFetch();
    const { c, requests } = client({ fetch: f.fn });
    await c.getJson({ host: "www.linkedin.com", path: "/voyager/api/voyagerJobsDashJobCards", query: { keywords: "react", start: 0 } });
    expect(f.calls[0]!.url).toBe("https://www.linkedin.com/voyager/api/voyagerJobsDashJobCards?keywords=react&start=0");
    expect(f.calls[0]!.headers).toMatchObject({ Cookie: `li_at=${LI_AT}`, "csrf-token": CSRF });
    expect(requests).toEqual([{ method: "GET", host: "www.linkedin.com", path: "/voyager/api/voyagerJobsDashJobCards" }]);
    expect(JSON.stringify(requests)).not.toContain(LI_AT);
  });

  it("three requests to one host are at least 1500 ms apart (NFR-1)", async () => {
    const at: number[] = [];
    let clock = () => 0;
    const fn: HttpFetch = async () => {
      at.push(clock());
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const h = client({ fetch: fn });
    clock = h.clock;
    const req = { host: "www.linkedin.com", path: "/voyager/api/jobs/jobPostings/1" };
    await Promise.all([h.c.get(req), h.c.get(req), h.c.get(req)]);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(1_500);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(1_500);
  });

  it("a missing credential sends no request", async () => {
    const f = fakeFetch();
    const { c } = client({ fetch: f.fn, credentials: null });
    await expect(c.get({ host: "www.linkedin.com", path: "/voyager/api/jobs/jobPostings/1" })).rejects.toThrow(MissingCredential);
    const partial = client({ fetch: f.fn, credentials: { li_at: LI_AT } });
    await expect(partial.c.get({ host: "www.linkedin.com", path: "/voyager/api/jobs/jobPostings/1" })).rejects.toThrow(/csrf-token/);
    expect(f.calls).toHaveLength(0);
  });

  it("401/403 are AuthRejected, 503 is transient; no error text carries a credential", async () => {
    for (const [status, type] of [[401, AuthRejected], [403, AuthRejected]] as const) {
      const { c } = client({ fetch: fakeFetch(() => ({ status })).fn });
      await expect(c.get({ host: "www.linkedin.com", path: "/voyager/api/jobs/jobPostings/1" })).rejects.toThrow(type);
    }
    const redactor = new Redactor();
    redactor.register([LI_AT]);
    const { c } = client({ redactor, fetch: async () => { throw new Error(`socket hang up (cookie li_at=${LI_AT})`); } });
    const err = await c.get({ host: "www.linkedin.com", path: "/voyager/api/jobs/jobPostings/1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoardApiError);
    expect(err).toMatchObject({ kind: "transient" });
    expect(String((err as Error).message)).not.toContain(LI_AT);
    const s503 = client({ fetch: fakeFetch(() => ({ status: 503 })).fn });
    await expect(s503.c.get({ host: "www.linkedin.com", path: "/voyager/api/jobs/jobPostings/1" })).rejects.toMatchObject({ kind: "transient", message: expect.stringMatching(/HTTP 503/) });
  });

  it("a board without auth needs no credential", async () => {
    const open = SourceAccessRecordSchema.parse({ ...linkedin, source: "itviec", auth: { kind: "none", names: [], howToCopy: "" }, riskLevel: "low" });
    const f = fakeFetch();
    const { c } = client({ fetch: f.fn, record: open, credentials: null });
    await c.get({ host: "www.linkedin.com", path: "/voyager/api/jobs/jobPostings/1" });
    expect(f.calls[0]!.headers.Cookie).toBeUndefined();
  });

  describe("redirects (never followed blindly)", () => {
    type Hop = { status: number; location?: string; body?: string };
    function redirecting(plan: Record<string, Hop>) {
      const calls: { url: string; redirect: string | undefined; headers: Record<string, string> }[] = [];
      const fn: HttpFetch = async (url, init) => {
        calls.push({ url, redirect: init.redirect, headers: init.headers });
        const a = plan[url] ?? { status: 404 };
        return { ok: a.status < 300, status: a.status, text: async () => a.body ?? "", headers: { get: (n: string) => (n.toLowerCase() === "location" ? (a.location ?? null) : null) } };
      };
      return { fn, calls };
    }
    const SEARCH = "https://www.linkedin.com/voyager/api/voyagerJobsDashJobCards";

    it("a same-host hop to a listed endpoint is checked, gated (≥ 1500 ms) and recorded like a request; fetch never follows by itself", async () => {
      const f = redirecting({ [`${SEARCH}?keywords=react`]: { status: 302, location: "/voyager/api/jobs/jobPostings/7" }, "https://www.linkedin.com/voyager/api/jobs/jobPostings/7": { status: 200, body: "ok" } });
      const at: number[] = [];
      const { c, requests, clock } = client({ fetch: async (u, i) => (at.push(clock()), f.fn(u, i)) });
      const page = await c.getPage({ host: "www.linkedin.com", path: "/voyager/api/voyagerJobsDashJobCards", query: { keywords: "react" } });
      expect(page.body).toBe("ok");
      expect(page.url.toString()).toBe("https://www.linkedin.com/voyager/api/jobs/jobPostings/7");
      expect(f.calls.map((x) => x.redirect)).toEqual(["manual", "manual"]);
      expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(1_500);
      expect(requests.map((r) => r.path)).toEqual(["/voyager/api/voyagerJobsDashJobCards", "/voyager/api/jobs/jobPostings/7"]);
    });

    it("a hop to an apply endpoint, an unlisted query, another host or plain http is refused before it is sent", async () => {
      for (const location of [
        "/voyager/api/jobs/jobPostings/7/apply",
        "/voyager/api/jobs/jobPostings/7?trk=1",
        "https://evil.example/voyager/api/jobs/jobPostings/7",
        "http://www.linkedin.com/voyager/api/jobs/jobPostings/7",
      ]) {
        const f = redirecting({ [`${SEARCH}?keywords=react`]: { status: 301, location } });
        const { c } = client({ fetch: f.fn });
        await expect(c.get({ host: "www.linkedin.com", path: "/voyager/api/voyagerJobsDashJobCards", query: { keywords: "react" } }), location).rejects.toThrow(EndpointNotAllowed);
        expect(f.calls, location).toHaveLength(1);
      }
    });

    it("more than three hops fail the request", async () => {
      const f = redirecting({
        [`${SEARCH}?keywords=a`]: { status: 302, location: `${SEARCH}?keywords=b` },
        [`${SEARCH}?keywords=b`]: { status: 302, location: `${SEARCH}?keywords=c` },
        [`${SEARCH}?keywords=c`]: { status: 302, location: `${SEARCH}?keywords=d` },
        [`${SEARCH}?keywords=d`]: { status: 302, location: `${SEARCH}?keywords=e` },
      });
      const { c } = client({ fetch: f.fn });
      await expect(c.get({ host: "www.linkedin.com", path: "/voyager/api/voyagerJobsDashJobCards", query: { keywords: "a" } })).rejects.toMatchObject({ name: "BoardApiError", message: expect.stringMatching(/redirected more than 3 times/) });
      expect(f.calls).toHaveLength(4);
    });
  });

  it("a body over the size cap stops being read part way (streamed with a running byte count)", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled++;
        if (pulled > 100) ctrl.close();
        else ctrl.enqueue(new Uint8Array(1024));
      },
    });
    const f: HttpFetch = async () => ({ ok: true, status: 200, text: async () => "", body });
    let now = 0;
    const c = new BoardApiClient({ record: linkedin, path: "account_api", fetch: f, gate: new HostGate({ now: () => now, sleep: async (ms) => void (now += ms) }), credentials: { li_at: LI_AT, "csrf-token": CSRF }, maxBodyBytes: 4096 });
    await expect(c.get({ host: "www.linkedin.com", path: "/voyager/api/jobs/jobPostings/1" })).rejects.toMatchObject({ message: expect.stringMatching(/answered more than 4096 bytes/) });
    expect(pulled).toBeLessThan(10);
  });
});
