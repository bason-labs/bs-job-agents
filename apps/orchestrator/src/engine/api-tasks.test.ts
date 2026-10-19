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
import { readFileSync } from "node:fs";
import { approveSource, listJobs, listSkillRepairs } from "../db/index.js";
import type { ScanOutputChecker } from "./scan-check.js";
import { skillRepairActivity } from "./skill-repair.js";
import { MemorySkillFiles } from "./testing/index.js";
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

  it("two API tasks running at once against one host share the process's 1500 ms gate (NFR-1)", async () => {
    const at: { url: string; t: number }[] = [];
    let now = 0;
    const gate = new HostGate({ now: () => now, sleep: async (ms) => void (now += Math.max(0, ms)) });
    const fetch: HttpFetch = async (url) => {
      at.push({ url, t: now });
      return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: [] }) };
    };
    const shared = (source: BoardSource) =>
      record(source, { auth: { kind: "none", names: [], howToCopy: "" }, internalApiGetEndpoints: [{ method: "GET", host: "jobs.shared.example", pathPattern: "/api/jobs", query: ["page"], purpose: "search", requiresAuth: false }] });
    const twice = (source: BoardSource): BoardMapper => ({
      source,
      async scan(client, _input, signal) {
        await client.get({ host: "jobs.shared.example", path: "/api/jobs", query: { page: 1 } }, signal);
        await client.get({ host: "jobs.shared.example", path: "/api/jobs", query: { page: 2 } }, signal);
        return { jobs: [] };
      },
    });
    const records = { itviec: shared("itviec"), topcv: shared("topcv") } as Partial<Record<BoardSource, SourceAccessRecord>>;
    const port = new BoardApiScanner({ fetch, gate, secrets: null, mappers: { itviec: twice("itviec"), topcv: twice("topcv") }, records: (s) => records[s] ?? record(s) });
    const t = await createTestEngine({ sources: ["itviec", "topcv"], boards: port });
    t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect(at).toHaveLength(4);
    expect(scanOf(t, "itviec").status).toBe("done");
    expect(scanOf(t, "topcv").status).toBe("done");
    for (let i = 1; i < at.length; i++) expect(at[i]!.t - at[i - 1]!.t).toBeGreaterThanOrEqual(1_500);
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

describe("skill self-repair §5.8: the API changed", () => {
  /** The API answers `status` while `broken()` holds, else two jobs. */
  function flaky(broken: () => boolean, status = 404) {
    return fakeFetch(() => (broken() ? { status, body: "not found" } : { status: 200, body: twoJobs("itviec") }));
  }
  const apiEvents = (t: TestEngine) => t.allEvents().filter((e) => e.type === "source_api.changed" || e.type === "source_api.recovered");

  it.each([404, 410])("HTTP %i on a listed endpoint: this run reads the board in the browser, Ba is told once, the next run tries the API first and recovers on its own", async (status) => {
    let broken = true;
    const http = flaky(() => broken, status);
    const t = await createTestEngine({ sources: ["itviec"], boards: boards({ fetch: http.fn }) });
    const run = t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect(scanOf(t, "itviec")).toMatchObject({ status: "done", usesBrowser: true, attempt: 1 });
    expect(runnerSources(t)).toEqual(["itviec"]);
    expect((t.step(run.id, "scan-join")!.output as JoinStepOutput).failures).toEqual([]);
    const changed = t.events("source_api.changed");
    expect(changed).toEqual([expect.objectContaining({ source: "itviec", method: "GET", host: "itviec.com", path: "/api/jobs", reason: `itviec.com/api/jobs answered HTTP ${status}` })]);
    // No query, no header value.
    expect(JSON.stringify(changed)).not.toMatch(/keywords|_session|SECRET/);
    expect(leadTexts(t).filter((x) => /API/.test(x))).toEqual([
      `ITviec API changed: itviec.com/api/jobs answered HTTP ${status}. Scanned through the browser this time; scans use the browser until the API works again.`,
    ]);

    // Still broken: the API is tried first (one request), the browser covers the run, no second notice.
    const again = await createTestEngine({ sources: ["itviec"], db: t.db, clock: t.clock, files: t.files, boards: boards({ fetch: http.fn }) });
    again.engine.startWorkflow(START, { trigger: "chat" });
    await again.idle();
    expect(http.calls).toHaveLength(2);
    expect(apiEvents(again).map((e) => e.type)).toEqual(["source_api.changed"]);
    expect(leadTexts(again).filter((x) => /API changed/.test(x))).toHaveLength(1);

    // Works again: read through the API, one recovery notice and Activity entry, nothing for Ba to do.
    broken = false;
    const back = await createTestEngine({ sources: ["itviec"], db: t.db, clock: t.clock, files: t.files, boards: boards({ fetch: http.fn }) });
    back.engine.startWorkflow(START, { trigger: "chat" });
    await back.idle();
    expect(back.runner.callsFor("research.scan")).toHaveLength(0);
    expect(apiEvents(back).map((e) => e.type)).toEqual(["source_api.changed", "source_api.recovered"]);
    expect(leadTexts(back).filter((x) => x.startsWith("ITviec API works again"))).toEqual(["ITviec API works again; scans are back on the API."]);
    // The Activity screen: "API changed" then "API recovered", newest first, with no diff.
    expect(skillRepairActivity(back.db, null).map((e) => [e.kind, e.source])).toEqual([
      ["api_recovered", "itviec"],
      ["api_changed", "itviec"],
    ]);
  });

  it("a list whose postings are all invalid is a changed API (browser this run), not 0 jobs", async () => {
    const body = JSON.stringify({ jobs: [{ id: 1, title: "Frontend Engineer", url: null }, { id: 2, title: "Backend Engineer", url: null }] });
    const t = await createTestEngine({ sources: ["itviec"], boards: boards({ fetch: fakeFetch(() => ({ status: 200, body })).fn }) });
    t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect(scanOf(t, "itviec")).toMatchObject({ status: "done", usesBrowser: true });
    expect(t.events("source_api.changed")).toEqual([expect.objectContaining({ source: "itviec", method: null, reason: expect.stringMatching(/^ITviec: none of the 2 postings the API gave is valid/) })]);
  });

  it("a transient error is not a changed API: retried, then the source fails (no fallback, no notice)", async () => {
    const t = await createTestEngine({ sources: ["itviec"], boards: boards({ fetch: fakeFetch(() => ({ status: 503 })).fn }) });
    t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect(scanOf(t, "itviec")).toMatchObject({ status: "failed", usesBrowser: false });
    expect(t.events("source_api.changed")).toEqual([]);
  });

  it("REQ-8 (AD-7): an API-path scan that fails as adapter broken starts no skill repair", async () => {
    const skills = new MemorySkillFiles({ itviec: "x" });
    const checker: ScanOutputChecker = { check: () => ({ ok: false, adapterBroken: true, reason: "no job cards", screenshot: null }) };
    const t = await createTestEngine({ sources: ["itviec"], boards: boards({ fetch: fakeFetch(() => ({ status: 200, body: twoJobs("itviec") })).fn }), scanChecker: checker, skills });
    t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect(scanOf(t, "itviec")).toMatchObject({ status: "failed", usesBrowser: false, error: expect.stringMatching(/^adapter broken: /) });
    expect(listSkillRepairs(t.db)).toEqual([]);
    expect(t.runner.callsFor("research.repair")).toHaveLength(0);
  });

  it("§5.8 step 5: when the fallback browser scan finds the skill stale, the normal skill repair runs", async () => {
    const skills = new MemorySkillFiles({ itviec: readFileSync(new URL("../../../../bots/research/skills/source-itviec/SKILL.md", import.meta.url), "utf8") });
    const checker: ScanOutputChecker = {
      check: (i) => (i.via === undefined && (i.input as { skillOverride?: unknown }).skillOverride === undefined ? { ok: false, adapterBroken: true, reason: "no job cards", screenshot: null } : { ok: true }),
    };
    const t = await createTestEngine({ sources: ["itviec"], boards: boards({ fetch: fakeFetch(() => ({ status: 404 })).fn }), scanChecker: checker, skills });
    t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect(t.events("source_api.changed")).toHaveLength(1);
    expect(listSkillRepairs(t.db).map((r) => [r.source, r.status])).toEqual([["itviec", "adopted"]]);
  });
});
