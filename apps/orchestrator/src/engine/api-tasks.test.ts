// API research (AD-5, design §5.4): boards read through an API are fetched by the orchestrator
// (ApiTaskRunner + deps.boards): their research.scan never reaches a runner (no Chrome tool, no
// Claude session). A missing or rejected token falls back to a browser scan of the same source in
// the same run, with a renew notice; a transient failure, once retried, fails the source alone.
import { SourceAccessRecordSchema, type BoardSource, type JobCandidate, type SourceAccessRecord } from "@bs-job-agents/shared";
import { researchScanFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { BoardApiScanner, type BoardMapper } from "../adapters/board-api/index.js";
import { HostGate, type HttpFetch } from "../adapters/http/index.js";
import { Redactor } from "../adapters/secrets/index.js";
import { approveSource, listJobs } from "../db/index.js";
import type { SecretStore } from "./ports.js";
import type { JoinStepOutput } from "./state.js";
import { createTestEngine, type TestEngine } from "./testing/harness.js";

const TOKEN = "itviec-session-SECRET-0123456789";
const LI_AT = "AQEDAR-linkedin-SECRET-987654";
const JD = researchScanFixture.jobs[0]!.jdText;
const START = { workflow: "job-scan", params: { searchProfileId: null, overrides: null } } as const;

function record(source: BoardSource, over: Partial<SourceAccessRecord> = {}): SourceAccessRecord {
  const host = source === "linkedin" ? "www.linkedin.com" : `${source}.com`;
  return SourceAccessRecordSchema.parse({
    source,
    researchedAt: "2026-10-19T08:00:00.000Z",
    publicApi: "none found",
    internalApiGetEndpoints: [{ method: "GET", host, pathPattern: "/api/jobs", query: ["keywords"], purpose: "search", requiresAuth: true }],
    applyEndpoints: [{ method: "POST", host, pathPattern: "/api/jobs/:id/apply", purpose: "other", requiresAuth: true, documentedOnly: true }],
    auth: { kind: "cookie", names: [source === "linkedin" ? "li_at" : "_session"], howToCopy: "DevTools → Cookies" },
    termsOfUse: { url: `https://${host}/terms`, clauses: ["No scraping."] },
    accountRisk: "Low: no known restrictions.",
    riskLevel: "low",
    chosenPath: "account_api",
    ...over,
  });
}

/** A mapper that reads /api/jobs once and keeps whatever it got. */
function mapper(source: BoardSource): BoardMapper {
  const host = source === "linkedin" ? "www.linkedin.com" : `${source}.com`;
  return {
    source,
    async scan(client, input, signal) {
      const body = (await client.getJson({ host, path: "/api/jobs", query: { keywords: input.criteria.roles.join(" ") } }, signal)) as { jobs: { id: number; title: string; url: string | null }[] };
      const jobs: JobCandidate[] = body.jobs.map((j) => ({
        source,
        url: j.url,
        title: j.title,
        company: `Company ${j.id}`,
        companyWebsite: null,
        location: "Ho Chi Minh City",
        workMode: "hybrid",
        salaryText: null,
        postedAt: null,
        language: "en",
        jdText: JD,
      }));
      return { jobs, note: "1 search page" };
    },
  };
}

const twoJobs = (source: string) =>
  JSON.stringify({
    jobs: [
      { id: 1, title: "Frontend Engineer", url: `https://${source}.com/it-jobs/frontend-engineer-1` },
      { id: 2, title: "Backend Engineer", url: `https://${source}.com/it-jobs/backend-engineer-2` },
    ],
  });

function fakeFetch(plan: (url: string, n: number) => { status: number; body?: string } | Error) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn: HttpFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const a = plan(url, calls.length);
    if (a instanceof Error) throw a;
    return { ok: a.status < 300, status: a.status, text: async () => a.body ?? "" };
  };
  return { fn, calls };
}

function secrets(values: Record<string, Record<string, string>>): SecretStore & { redactor: Redactor } {
  const redactor = new Redactor();
  return {
    redactor,
    credentials: (s) => {
      const v = values[s];
      if (!v) return null;
      redactor.register(Object.values(v));
      return v;
    },
    has: (s) => values[s] !== undefined,
  };
}

function boards(opts: { fetch: HttpFetch; values?: Record<string, Record<string, string>>; records?: Partial<Record<BoardSource, SourceAccessRecord>> }) {
  const store = secrets(opts.values ?? { itviec: { _session: TOKEN } });
  const records = { itviec: record("itviec"), ...opts.records };
  return new BoardApiScanner({
    fetch: opts.fetch,
    gate: new HostGate({ sleep: async () => undefined }),
    secrets: store,
    redactor: store.redactor,
    mappers: { itviec: mapper("itviec"), linkedin: mapper("linkedin") },
    records: (s) => records[s] ?? SourceAccessRecordSchema.parse({ ...record(s), internalApiGetEndpoints: "none found", chosenPath: "browser" }),
  });
}

const scanOf = (t: TestEngine, source: string) => t.tasks("research.scan").find((x) => (x.input as { source: string }).source === source)!;
const leadTexts = (t: TestEngine) => t.events("message.created").map((e) => e.message).filter((m) => m.author.type === "bot" && m.author.bot === "lead").map((m) => m.text);
const runnerSources = (t: TestEngine) => t.runner.callsFor("research.scan").map((c) => (c.input as { source: string }).source);

describe("API scans (no bot, no Chrome)", () => {
  it("an account-API board is fetched by the orchestrator with Ba's token; nothing reaches a runner (REQ-1.AC-2, REQ-2.AC-1, REQ-24.AC-1)", async () => {
    const http = fakeFetch(() => ({ status: 200, body: twoJobs("itviec") }));
    const t = await createTestEngine({ sources: ["itviec", "topcv"], boards: boards({ fetch: http.fn }) });
    const run = t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();

    const itviec = scanOf(t, "itviec");
    expect(itviec).toMatchObject({ status: "done", usesBrowser: false });
    expect(runnerSources(t)).toEqual(["topcv"]);
    expect(http.calls[0]!.headers.Cookie).toBe(`_session=${TOKEN}`);
    expect((itviec.output as { jobs: unknown[] }).jobs).toHaveLength(2);
    const join = t.step(run.id, "scan-join")!.output as JoinStepOutput;
    expect(join.failures).toEqual([]);
    expect(listJobs(t.db).filter((j) => j.source === "itviec").map((j) => j.title)).toEqual(expect.arrayContaining(["Frontend Engineer", "Backend Engineer"]));

    // REQ-23.AC-2: each request is on the task, method + host + path, no query and no header value.
    const requests = t.events("task.progress").filter((e) => e.taskId === String(itviec.id) && e.tool === "board-api").map((e) => e.text);
    expect(requests).toEqual(["GET itviec.com/api/jobs"]);
    expect(JSON.stringify(t.allEvents())).not.toContain(TOKEN);
  });

  it("zero postings: the branch completes with 0 jobs and no error (REQ-1.AC-3)", async () => {
    const http = fakeFetch(() => ({ status: 200, body: JSON.stringify({ jobs: [] }) }));
    const t = await createTestEngine({ sources: ["itviec"], boards: boards({ fetch: http.fn }) });
    t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect(scanOf(t, "itviec")).toMatchObject({ status: "done", error: null, output: { jobs: [] } });
  });

  it("a posting without a URL is dropped, the other kept (REQ-3.AC-1)", async () => {
    const body = JSON.stringify({ jobs: [{ id: 1, title: "Frontend Engineer", url: null }, { id: 2, title: "Backend Engineer", url: "https://itviec.com/it-jobs/backend-engineer-2" }] });
    const t = await createTestEngine({ sources: ["itviec"], boards: boards({ fetch: fakeFetch(() => ({ status: 200, body })).fn }) });
    t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect((scanOf(t, "itviec").output as { jobs: { title: string }[] }).jobs.map((j) => j.title)).toEqual(["Backend Engineer"]);
  });

  it("token missing: no request, the same source is scanned in the browser this run, not a failed source, and Ba is told to renew it (design §5.4)", async () => {
    const http = fakeFetch(() => ({ status: 200, body: twoJobs("itviec") }));
    const t = await createTestEngine({ sources: ["itviec", "topcv"], boards: boards({ fetch: http.fn, values: {} }) });
    const run = t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();

    expect(http.calls).toHaveLength(0);
    expect(runnerSources(t).sort()).toEqual(["itviec", "topcv"]);
    expect(scanOf(t, "itviec")).toMatchObject({ status: "done", usesBrowser: true, attempt: 1 });
    expect((t.step(run.id, "scan-join")!.output as JoinStepOutput).failures).toEqual([]);
    expect(leadTexts(t)).toContain("ITviec token missing — scanned through the browser this time. Renew the ITviec token in your secrets file.");
    expect(leadTexts(t).some((x) => /scan failed/.test(x))).toBe(false);
  });

  it("token rejected (401): no retry, partial jobs discarded, browser fallback, renew notice without the value (REQ-6.AC-3, REQ-25 as changed)", async () => {
    for (const status of [401, 403]) {
      const http = fakeFetch(() => ({ status }));
      const t = await createTestEngine({ sources: ["itviec"], boards: boards({ fetch: http.fn }) });
      t.engine.startWorkflow(START, { trigger: "chat" });
      await t.idle();
      expect(http.calls).toHaveLength(1);
      expect(runnerSources(t)).toEqual(["itviec"]);
      expect(scanOf(t, "itviec")).toMatchObject({ status: "done", usesBrowser: true });
      expect(leadTexts(t)).toContain("ITviec token rejected — scanned through the browser this time. Renew the ITviec token in your secrets file.");
      expect(JSON.stringify(t.allEvents())).not.toContain(TOKEN);
    }
  });

  it("a board read with no token (auth none) answering 403, e.g. a bot check: browser fallback, not a failed source, and no 'renew the token' notice", async () => {
    const http = fakeFetch(() => ({ status: 403 }));
    const direct = record("itviec", { auth: { kind: "none", names: [], howToCopy: "" } });
    const t = await createTestEngine({ sources: ["itviec"], boards: boards({ fetch: http.fn, values: {}, records: { itviec: direct } }) });
    const run = t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect(http.calls).toHaveLength(1);
    expect(runnerSources(t)).toEqual(["itviec"]);
    expect(scanOf(t, "itviec")).toMatchObject({ status: "done", usesBrowser: true });
    expect((t.step(run.id, "scan-join")!.output as JoinStepOutput).failures).toEqual([]);
    expect(leadTexts(t)).toContain("ITviec refused the direct read (HTTP 403) — scanned through the browser this time.");
    expect(leadTexts(t).join("\n")).not.toMatch(/token/i);
  });

  it("503 on every attempt: retried, then the source fails with the notice and the others go on; no browser fallback (REQ-6.AC-1)", async () => {
    const http = fakeFetch(() => ({ status: 503 }));
    const t = await createTestEngine({ sources: ["itviec", "topcv"], boards: boards({ fetch: http.fn }) });
    const run = t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect(http.calls).toHaveLength(2);
    expect(runnerSources(t)).toEqual(["topcv"]);
    expect(scanOf(t, "itviec")).toMatchObject({ status: "failed", attempt: 2, usesBrowser: false });
    expect(leadTexts(t)).toContainEqual(expect.stringMatching(/^ITviec scan failed: .*HTTP 503.*\. The other sources go on\.$/));
    expect((t.step(run.id, "scan-join")!.output as JoinStepOutput).failures).toEqual([expect.objectContaining({ item: "itviec" })]);
  });

  it("503 once, then 200: the branch completes with those jobs (REQ-6.AC-2)", async () => {
    const http = fakeFetch((_u, n) => (n === 1 ? { status: 503 } : { status: 200, body: twoJobs("itviec") }));
    const t = await createTestEngine({ sources: ["itviec"], boards: boards({ fetch: http.fn }) });
    t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect(scanOf(t, "itviec")).toMatchObject({ status: "done", attempt: 2 });
    expect((scanOf(t, "itviec").output as { jobs: unknown[] }).jobs).toHaveLength(2);
  });

  it("a credential that leaks into an error never reaches a notice, an event or the task error", async () => {
    const http = fakeFetch(() => new Error(`socket hang up sending _session=${TOKEN}`));
    const t = await createTestEngine({ sources: ["itviec", "topcv"], boards: boards({ fetch: http.fn }) });
    t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    const task = scanOf(t, "itviec");
    expect(task.status).toBe("failed");
    expect(task.error).toContain("[redacted]");
    expect(JSON.stringify(t.allEvents())).not.toContain(TOKEN);
    expect(leadTexts(t).join("\n")).not.toContain(TOKEN);
  });

  it("a high-risk board stays on the browser until Ba approves it; the approval lapses with new research (decision 2)", async () => {
    const high = record("linkedin", { riskLevel: "high", accountRisk: "High: accounts are restricted for automation." });
    const http = fakeFetch(() => ({ status: 200, body: twoJobs("www.linkedin") }));
    const port = boards({ fetch: http.fn, values: { linkedin: { li_at: LI_AT } }, records: { linkedin: high } });
    const t = await createTestEngine({ sources: ["linkedin"], boards: port });
    t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect(http.calls).toHaveLength(0);
    expect(runnerSources(t)).toEqual(["linkedin"]);

    approveSource(t.db, { source: "linkedin", researchedAt: "an older research" }, { now: t.clock.now() });
    t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect(http.calls).toHaveLength(0);

    approveSource(t.db, { source: "linkedin", researchedAt: high.researchedAt }, { now: t.clock.now() });
    t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect(http.calls).toHaveLength(1);
    expect(runnerSources(t)).toEqual(["linkedin", "linkedin"]);
  });

  it("LinkedIn's real record says account API, but it has no mapper: approved and with a token, it is still read in the browser", async () => {
    const http = fakeFetch(() => ({ status: 200, body: "{}" }));
    // The production records and mappers (BOARD_MAPPERS has no linkedin entry).
    const port = new BoardApiScanner({ fetch: http.fn, gate: new HostGate({ sleep: async () => undefined }), secrets: secrets({ linkedin: { li_at: LI_AT, JSESSIONID: "x", "csrf-token": "y" } }) });
    expect(port.record("linkedin").chosenPath).toBe("account_api");
    expect(port.canScan("linkedin")).toBe(false);
    const t = await createTestEngine({ sources: ["linkedin"], boards: port });
    approveSource(t.db, { source: "linkedin", researchedAt: port.record("linkedin").researchedAt }, { now: t.clock.now() });
    t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect(http.calls).toHaveLength(0);
    expect(runnerSources(t)).toEqual(["linkedin"]);
  });

  it("a board whose public API is usable is read through it and its token is never read (REQ-21.AC-1)", async () => {
    const publicApi = { usable: true, needsDeveloperKey: false, endpoints: [{ method: "GET" as const, host: "itviec.com", pathPattern: "/api/jobs", query: ["keywords"], purpose: "search" as const, requiresAuth: false }] };
    const http = fakeFetch(() => ({ status: 200, body: twoJobs("itviec") }));
    let reads = 0;
    const store: SecretStore = { credentials: () => (reads++, { _session: TOKEN }), has: () => true };
    const port = new BoardApiScanner({ fetch: http.fn, gate: new HostGate({ sleep: async () => undefined }), secrets: store, mappers: { itviec: mapper("itviec") }, records: () => record("itviec", { publicApi, chosenPath: "public_api" }) });
    const t = await createTestEngine({ sources: ["itviec"], boards: port });
    t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect(scanOf(t, "itviec").status).toBe("done");
    expect(reads).toBe(0);
    expect(http.calls[0]!.headers.Cookie).toBeUndefined();
  });

  it("an API job with the URL an earlier browser scan found stays one job after dedupe (REQ-3.AC-2)", async () => {
    const http = fakeFetch(() => ({ status: 200, body: twoJobs("itviec") }));
    const t = await createTestEngine({ sources: ["itviec"] });
    t.runner.script({ bot: "research", kind: "scan", result: { status: "ok", output: { ...researchScanFixture, jobs: [{ ...researchScanFixture.jobs[0]!, source: "itviec", url: "https://itviec.com/it-jobs/frontend-engineer-1", title: "Frontend Engineer", company: "Company 1", location: "Ho Chi Minh City", workMode: "hybrid" }] }, sessionId: null, durationMs: 1 } });
    t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    const before = listJobs(t.db).filter((j) => j.url === "https://itviec.com/it-jobs/frontend-engineer-1");
    expect(before).toHaveLength(1);

    const api = await createTestEngine({ sources: ["itviec"], db: t.db, clock: t.clock, files: t.files, boards: boards({ fetch: http.fn }) });
    api.engine.startWorkflow(START, { trigger: "chat" });
    await api.idle();
    expect(http.calls).toHaveLength(1);
    expect(listJobs(t.db).filter((j) => j.url === "https://itviec.com/it-jobs/frontend-engineer-1")).toHaveLength(1);
  });
});
