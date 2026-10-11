import { CSRF_HEADER, CSRF_HEADER_VALUE, type BotView, type EngineStatus, type Room } from "@bs-job-agents/shared";
import { messageFixture, reviewCardFixture, runFixture, stepFixture, taskFixture, uploadFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import type { EventFeed } from "./contract";
import { isApiError } from "./errors";
import { createHttpApi } from "./http";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch double: answers by "METHOD /path" (query included) and records every call. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body instanceof FormData ? init.body : typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, url, headers, body });
    const path = url.replace("http://orch.test", "");
    const handler = routes[`${method} ${path}`];
    if (!handler) return json({ error: { code: "not_found", message: `no route ${method} ${path}`, details: null } }, 404);
    return handler();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const noFeed: EventFeed = { subscribe: () => () => {}, getStatus: () => "idle", onStatus: () => () => {} };

const api = (routes: Record<string, () => Response | Promise<Response>>) => {
  const f = fakeFetch(routes);
  return { ...f, api: createHttpApi({ baseUrl: "http://orch.test", fetch: f.fetchImpl, events: noFeed }) };
};

const BOT: BotView = {
  name: "research",
  displayName: "Research",
  engine: "codex",
  model: null,
  trustLevel: 2,
  promptVersion: 2,
  enabled: true,
  role: "Finds jobs",
  activity: "idle",
  trackRecord: null,
  promotionSuggested: false,
  promoteAllowed: true,
  memory: [],
  residualRisk: null,
};
const LEAD: BotView = { ...BOT, name: "lead", displayName: "Lead", engine: "claude", trustLevel: 1 };
const ROOMS: Room[] = [
  { id: "1", name: "Lead", kind: "lead", botName: "lead", members: ["lead"], createdAt: "2026-10-10T08:00:00Z" },
  { id: "3", name: "cv-brainstorm", kind: "group", botName: null, members: ["cv"], createdAt: "2026-10-10T08:00:00Z" },
];
const ENGINES: EngineStatus[] = [
  { engine: "claude", pausedUntil: "2026-10-10T14:05:00+07:00", reason: "usage_limit", usage: null, activeSessions: 0, maxSessions: 2 },
];

describe("createHttpApi: reads", () => {
  it("GET /review parses the shared ReviewQueueResponse", async () => {
    const { api: a, calls } = api({ "GET /review": () => json({ cards: [reviewCardFixture] }) });
    const cards = await a.getReviewQueue();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.job.company).toBe("NovaPay");
    expect(calls[0]).toMatchObject({ method: "GET", url: "http://orch.test/review" });
    expect(calls[0]!.headers.accept).toBe("application/json");
    expect(calls[0]!.headers[CSRF_HEADER]).toBeUndefined();
  });

  it("GET /rooms/:id/messages with the paging query", async () => {
    const { api: a, calls } = api({ "GET /rooms/7/messages?before=m1&limit=30": () => json({ messages: [messageFixture], hasMore: true }) });
    await expect(a.listMessages("7", { before: "m1", limit: 30 })).resolves.toEqual({ messages: [messageFixture], hasMore: true });
    expect(calls).toHaveLength(1);
  });

  it("runs: list (with the RunsQuery filter), detail and the step drawer's step", async () => {
    const { api: a } = api({
      "GET /runs": () => json({ runs: [runFixture] }),
      "GET /runs?status=running&limit=5": () => json({ runs: [] }),
      "GET /runs/run_13": () => json({ run: runFixture, steps: [stepFixture], tasks: [taskFixture] }),
      "GET /steps/step_7": () =>
        json({ step: stepFixture, tasks: [taskFixture], selfCheck: [{ item: "One A4 page", passed: true, note: null }], durationMs: 4200 }),
    });
    expect((await a.listRuns()).map((r) => r.id)).toEqual(["run_13"]);
    expect(await a.listRuns({ status: "running", limit: 5 })).toEqual([]);
    const detail = await a.getRun("run_13");
    expect(detail.steps[0]!.stepKey).toBe("tailor");
    expect(detail.tasks[0]!.botName).toBe("cv");
    const step = await a.getStep("step_7");
    expect(step.durationMs).toBe(4200);
    expect(step.selfCheck[0]!.item).toBe("One A4 page");
  });

  it("composes the sidebar from five lists", async () => {
    const { api: a } = api({
      "GET /bots": () => json({ bots: [BOT, LEAD] }),
      "GET /rooms": () => json({ rooms: ROOMS }),
      "GET /engines": () => json({ engines: ENGINES }),
      "GET /review": () => json({ cards: [reviewCardFixture, reviewCardFixture] }),
      "GET /runs": () => json({ runs: [{ ...runFixture, id: "12", status: "waiting" }] }),
    });
    const shell = await a.getShellData();
    expect(shell.bots.map((b) => b.name)).toEqual(["lead", "research"]);
    expect(shell.rooms).toEqual([{ id: "3", name: "cv-brainstorm" }]);
    expect(shell.usage[0]).toMatchObject({ label: "Claude", pausedUntil: "2026-10-10T14:05:00+07:00" });
    expect(shell.reviewCount).toBe(2);
    expect(shell.activeRunId).toBe("12");
    // No /bridges answer: the sidebar does not alarm.
    expect(shell.chromeConnected).toBe(true);
  });

  it("the sidebar's Chrome status comes from GET /bridges: not connected when an engine's extension does not answer", async () => {
    const lists = {
      "GET /bots": () => json({ bots: [BOT, LEAD] }),
      "GET /rooms": () => json({ rooms: ROOMS }),
      "GET /engines": () => json({ engines: ENGINES }),
      "GET /review": () => json({ cards: [] }),
      "GET /runs": () => json({ runs: [] }),
    };
    const bridges = (claude: boolean | null, codex: boolean | null) => () =>
      json({ chrome: [{ engine: "claude", connected: claude }, { engine: "codex", connected: codex }], checkedAt: "2026-10-10T08:00:00.000Z" });
    expect((await api({ ...lists, "GET /bridges": bridges(true, false) }).api.getShellData()).chromeConnected).toBe(false);
    expect((await api({ ...lists, "GET /bridges": bridges(true, true) }).api.getShellData()).chromeConnected).toBe(true);
    // Unknown (engine stopped) is not "not connected".
    expect((await api({ ...lists, "GET /bridges": bridges(null, null) }).api.getShellData()).chromeConnected).toBe(true);
  });

  it("getBot and getRoom look a name or id up in the lists", async () => {
    const { api: a } = api({ "GET /bots": () => json({ bots: [BOT, LEAD] }), "GET /rooms": () => json({ rooms: ROOMS }) });
    expect(await a.getBot("research")).toMatchObject({ name: "research", displayName: "Research", status: "idle" });
    expect(await a.getBot("nobody")).toBeNull();
    expect(await a.getRoom("3")).toEqual({ id: "3", name: "cv-brainstorm" });
    expect(await a.getRoom("99")).toBeNull();
  });

  it("health: ok, degraded (S19: 503 with a body) and unreachable never throw", async () => {
    expect(await api({ "GET /health": () => json({ ok: true }) }).api.getHealth()).toEqual({ ok: true, reason: null, detail: null });
    const detail = "bots/cv/ROLE.md changed but promptVersion is still 4: bump promptVersion in bots/cv/bot.json";
    const degraded = await api({ "GET /health": () => json({ ok: false, reason: "prompt_version_stale", detail }, 503) }).api.getHealth();
    expect(degraded).toEqual({ ok: false, reason: "prompt_version_stale", detail });
    // The web app's /api proxy answers 502 when nothing listens on the orchestrator's port.
    expect(await api({ "GET /health": () => new Response("Bad gateway", { status: 502 }) }).api.getHealth()).toEqual({
      ok: false,
      reason: "unreachable",
      detail: null,
    });
    const down = createHttpApi({
      baseUrl: "http://orch.test",
      events: noFeed,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    expect(await down.getHealth()).toEqual({ ok: false, reason: "unreachable", detail: null });
  });

  it("a transcript is the shared TranscriptResponse's lines; a task without one yet (404) reads as empty", async () => {
    const { api: a } = api({});
    expect(await a.getTranscript("t1")).toEqual([]);
    const lines = [
      { n: 1, kind: "system", text: "session started" },
      { n: 2, kind: "tool", text: "cua_repl — Opening TopCV" },
    ];
    const body = { taskId: "t1", attempt: 1, attempts: [1], lines, nextAfter: 2, truncated: false, running: true };
    expect(await api({ "GET /tasks/t1/transcript": () => json(body) }).api.getTranscript("t1")).toEqual(lines);
  });

  it("a transcript in another shape than the shared one is bad_response, not an empty drawer", async () => {
    const lines = [{ at: "2026-10-10T09:00:00+07:00", kind: "tool_use", text: "Opening TopCV", tool: "cua_repl" }];
    const err = await api({ "GET /tasks/t1/transcript": () => json({ lines }) })
      .api.getTranscript("t1")
      .catch((e: unknown) => e);
    expect(isApiError(err) && err.code).toBe("bad_response");
  });

  it("file URLs go through the base URL; Download adds ?download=1", () => {
    const { api: a } = api({});
    expect(a.fileUrl("file_pdf_1")).toBe("http://orch.test/files/file_pdf_1");
    expect(a.fileUrl("a b", { download: true })).toBe("http://orch.test/files/a%20b?download=1");
  });
});

describe("createHttpApi: commands", () => {
  it("approve posts the chosen CV and intro with the CSRF header; the result tolerates a nullable applicationId and reapproval", async () => {
    const { api: a, calls } = api({
      "POST /review/job_1/approve": () => json({ applicationId: null, taskId: null, approval: null, reapproval: true }),
    });
    const result = await a.approve("job_1", { cvVersionId: "cvv_2", introText: null });
    expect(result).toEqual({ applicationId: null, taskId: null, approval: null, reapproval: true });
    expect(calls[0]).toMatchObject({ method: "POST", body: { cvVersionId: "cvv_2", introText: null } });
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.headers[CSRF_HEADER]).toBe(CSRF_HEADER_VALUE);
  });

  it("approve sends dryRun only when asked", async () => {
    const { api: a, calls } = api({
      "POST /review/job_1/approve": () => json({ applicationId: "app_1", taskId: "t9", approval: null }),
    });
    const result = await a.approve("job_1", { cvVersionId: "cvv_2", introText: "Hi", dryRun: true });
    expect(result.reapproval).toBeFalsy();
    expect(calls[0]!.body).toEqual({ cvVersionId: "cvv_2", introText: "Hi", dryRun: true });
  });

  it("review decisions, injection confirm, answers, resume, run control, re-run, choice", async () => {
    const ok = () => json({ ok: true });
    const { api: a, calls } = api({
      "POST /review/job_1/request-changes": ok,
      "POST /review/job_1/skip": ok,
      "POST /review/job_1/confirm-injection": ok,
      "POST /questions/42/answer": () => json({ resumed: true, next: null }),
      "POST /tasks/42/resume": ok,
      "POST /runs/12/control": () => json({ run: { ...runFixture, id: "12", status: "paused" }, abortedTaskIds: [] }),
      "POST /steps/s1/rerun": ok,
      "POST /chat/choices": ok,
      "POST /tasks/43/decline-domain": ok,
    });
    await a.requestChanges("job_1", { comment: "Lead with Next.js" });
    await a.skip("job_1", { reason: "other", note: "too far" });
    await a.confirmInjection("job_1");
    await expect(a.answerQuestion("42", { field: "salary", mode: "negotiable", value: null, remember: true })).resolves.toEqual({ resumed: true, next: null });
    await a.resumeTask("42", { confirmDomain: "acme.wd3.myworkdayjobs.com" });
    await a.resumeTask("42");
    expect((await a.controlRun("12", "pause")).run.status).toBe("paused");
    await a.rerunStep("s1");
    await a.chooseOption({ messageId: "m1", key: "criteria-save:AbCdEf123456", optionId: "save" });
    await a.declineDomain("43");
    expect(calls.map((c) => [c.method, c.url.replace("http://orch.test", ""), c.body])).toEqual([
      ["POST", "/review/job_1/request-changes", { comment: "Lead with Next.js" }],
      ["POST", "/review/job_1/skip", { reason: "other", note: "too far" }],
      ["POST", "/review/job_1/confirm-injection", { confirmed: true }],
      ["POST", "/questions/42/answer", { field: "salary", mode: "negotiable", value: null, remember: true }],
      ["POST", "/tasks/42/resume", { confirmDomain: "acme.wd3.myworkdayjobs.com" }],
      ["POST", "/tasks/42/resume", { confirmDomain: null }],
      ["POST", "/runs/12/control", { action: "pause" }],
      ["POST", "/steps/s1/rerun", {}],
      ["POST", "/chat/choices", { messageId: "m1", key: "criteria-save:AbCdEf123456", optionId: "save" }],
      ["POST", "/tasks/43/decline-domain", {}],
    ]);
  });

  it("sendMessage posts the shared ChatSendRequest and returns the stored message", async () => {
    const { api: a, calls } = api({ "POST /chat/messages": () => json({ message: messageFixture, taskIds: ["7"] }) });
    await expect(a.sendMessage({ roomId: "room_lead", text: "Find jobs" })).resolves.toEqual(messageFixture);
    expect(calls[0]!.body).toEqual({ roomId: "room_lead", text: "Find jobs", uploadIds: [] });
  });

  it("uploads are multipart (files field) with the CSRF header and no hand-set content type", async () => {
    const { api: a, calls } = api({ "POST /uploads": () => json({ uploads: [uploadFixture], rejected: [] }) });
    const file = new File(["%PDF-1.4"], "JD_NovaPay.pdf", { type: "application/pdf" });
    const res = await a.uploadFiles([file]);
    expect(res.uploads[0]!.id).toBe("upl_1");
    const body = calls[0]!.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect((body.getAll("files")[0] as File).name).toBe("JD_NovaPay.pdf");
    expect(calls[0]!.headers["content-type"]).toBeUndefined();
    expect(calls[0]!.headers[CSRF_HEADER]).toBe(CSRF_HEADER_VALUE);
  });
});

describe("createHttpApi: errors", () => {
  it("a shared ApiError body becomes an ApiRequestError with its code and reason", async () => {
    const { api: a } = api({
      "POST /review/job_1/approve": () =>
        json({ error: { code: "forbidden", message: "Confirm the injection flag first", details: { reason: "injection_flagged" } } }, 403),
    });
    const err = await a.approve("job_1", { cvVersionId: "cvv_2", introText: null }).catch((e: unknown) => e);
    expect(isApiError(err) && err.code).toBe("forbidden");
    expect(isApiError(err) && err.reason).toBe("injection_flagged");
  });

  it("an unreachable orchestrator is code `unreachable`", async () => {
    const down = createHttpApi({
      baseUrl: "http://orch.test",
      events: noFeed,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    const err = await down.getReviewQueue().catch((e: unknown) => e);
    expect(isApiError(err) && err.code).toBe("unreachable");
  });

  it("a 2xx body that breaks the shared schema is `bad_response`, not silently used", async () => {
    const { api: a } = api({ "GET /review": () => json({ cards: [{ job: { id: 1 } }] }) });
    const err = await a.getReviewQueue().catch((e: unknown) => e);
    expect(isApiError(err) && err.code).toBe("bad_response");
  });
});

describe("saved presets on runs (PM3 S4)", () => {
  it("listRuns gives each run its preset's name from presetNames; getRun keeps presetName", async () => {
    const other = { ...runFixture, id: "run_14" };
    const { api: a } = api({
      "GET /runs": () => json({ runs: [runFixture, other], presetNames: { [runFixture.id]: "danang-react" } }),
      [`GET /runs/${runFixture.id}`]: () => json({ run: runFixture, steps: [], tasks: [], presetName: "danang-react" }),
    });
    expect((await a.listRuns()).map((r) => [r.id, r.presetName ?? null])).toEqual([
      [runFixture.id, "danang-react"],
      ["run_14", null],
    ]);
    expect((await a.getRun(runFixture.id)).presetName).toBe("danang-react");
  });
});
