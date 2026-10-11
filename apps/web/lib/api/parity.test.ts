// Phase 3 QA: the web side of the REST contract (shared API_CONTRACT). Fails on drift:
// - every contract route is called by the web app (the http client or a screen's data adapter),
//   or is listed below as deliberately unused, with the reason;
// - every call that validates its answer uses the contract's own response schema;
// - the mock backend serves every route the web app calls: a MOCK_ROUTES entry with the
//   contract's response schema, or a typed WebApi method (and the http client really sends that
//   method to that route, checked with a fetch double);
// - the client calls no route outside the contract.
// apps/orchestrator/src/api/contract-parity.test.ts checks the server against the same table.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as shared from "@bs-job-agents/shared";
import { API_CONTRACT, API_ROUTES, apiEndpoints, type ApiMethod, type ApiRouteKey } from "@bs-job-agents/shared";
import { messageFixture, reviewCardFixture, runFixture, stepFixture, taskFixture, uploadFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import type { WebApi } from "./contract";
import { createHttpApi } from "./http";
import { testMock } from "./mock/testing";
import { MOCK_ROUTES } from "./mock/routes";

const WEB_ROOT = join(import.meta.dirname, "..", "..");
const SCHEMAS = shared as unknown as Record<string, unknown>;
const label = (method: string, key: string) => `${method} ${key}`;
const KEY_BY_PATH = new Map(Object.entries(API_ROUTES).map(([k, p]) => [p as string, k as ApiRouteKey]));

/** Contract routes the web app never calls, and why. */
const UNUSED: Record<string, string> = {
  "GET status": "start-up recovery details for the runbook/CLI; the UI reads /health",
  "POST runs": "Ba never starts a run from the UI directly: Lead starts it (rule 1), schedules use run-now",
  "GET schedule": "the Schedules screen reads the list (GET /schedules) and edits rows from it",
  "GET exports": "the Applications screen shows the last export from GET /applications (lastExportAt)",
};

/** Source files (no tests, no mock) under the web app's lib/, components/ and app/. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== "node_modules" && name !== "mock") walk(p);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
  };
  for (const d of ["lib", "components", "app"]) walk(join(WEB_ROOT, d));
  return out;
}

interface Call {
  file: string;
  method: ApiMethod;
  key: string;
  schema: string | null;
}

/** Every `("METHOD", API_ROUTES.key, { … schema: X })` call in the web sources. */
function calls(): Call[] {
  const out: Call[] = [];
  const re = /\(\s*"(GET|POST|PUT|PATCH|DELETE)"\s*,\s*API_ROUTES\.([A-Za-z]+)/g;
  for (const file of sources()) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(re)) {
      // The call's options end at the first ")" that closes it; schema: is inside the same object.
      const rest = text.slice(m.index! + m[0].length, m.index! + m[0].length + 400);
      const end = rest.search(/\)\s*[).;,]/);
      const opts = end >= 0 ? rest.slice(0, end) : rest;
      const schema = /\bschema:\s*([A-Za-z]+)/.exec(opts)?.[1] ?? null;
      out.push({ file: relative(WEB_ROOT, file), method: m[1] as ApiMethod, key: m[2]!, schema });
    }
  }
  return out;
}

/** WebApi methods that call a route, with arguments for a fetch double. */
const WEBAPI: Array<{ fn: keyof WebApi; args: unknown[]; method: ApiMethod; key: ApiRouteKey; body: unknown }> = [
  { fn: "getHealth", args: [], method: "GET", key: "health", body: { ok: true } },
  { fn: "listBots", args: [], method: "GET", key: "bots", body: { bots: [] } },
  { fn: "listRooms", args: [], method: "GET", key: "rooms", body: { rooms: [] } },
  { fn: "listEngines", args: [], method: "GET", key: "engines", body: { engines: [] } },
  { fn: "listMessages", args: ["1"], method: "GET", key: "roomMessages", body: { messages: [], hasMore: false } },
  { fn: "sendMessage", args: [{ roomId: "1", text: "hi" }], method: "POST", key: "chatSend", body: { message: messageFixture, taskIds: [] } },
  { fn: "uploadFiles", args: [[new File(["x"], "a.txt", { type: "text/plain" })]], method: "POST", key: "uploads", body: { uploads: [uploadFixture], rejected: [] } },
  { fn: "answerQuestion", args: ["1", { field: "f", mode: "answer", value: "v", remember: false }], method: "POST", key: "answerQuestion", body: { resumed: true, next: null } },
  { fn: "resumeTask", args: ["1"], method: "POST", key: "taskResume", body: { ok: true } },
  { fn: "declineDomain", args: ["1"], method: "POST", key: "taskDeclineDomain", body: { ok: true } },
  { fn: "chooseOption", args: [{ messageId: "1", key: "k", optionId: "o" }], method: "POST", key: "chatChoices", body: { message: messageFixture, taskIds: [] } },
  { fn: "listRuns", args: [], method: "GET", key: "runs", body: { runs: [] } },
  { fn: "getRun", args: ["1"], method: "GET", key: "run", body: { run: runFixture, steps: [stepFixture], tasks: [taskFixture] } },
  { fn: "getStep", args: ["1"], method: "GET", key: "step", body: { step: stepFixture, tasks: [taskFixture], selfCheck: [], durationMs: 1 } },
  { fn: "controlRun", args: ["1", "pause"], method: "POST", key: "runControl", body: { run: runFixture, abortedTaskIds: [] } },
  { fn: "rerunStep", args: ["1"], method: "POST", key: "stepRerun", body: { ok: true } },
  { fn: "getTranscript", args: ["1"], method: "GET", key: "taskTranscript", body: { taskId: "1", attempt: 1, attempts: [1], lines: [], nextAfter: 0, truncated: false, running: false } },
  { fn: "getReviewQueue", args: [], method: "GET", key: "reviewQueue", body: { cards: [reviewCardFixture] } },
  { fn: "approve", args: ["1", { cvVersionId: "2", introText: null }], method: "POST", key: "reviewApprove", body: { applicationId: "3", taskId: "4", approval: null } },
  { fn: "requestChanges", args: ["1", { comment: "x" }], method: "POST", key: "reviewRequestChanges", body: { ok: true } },
  { fn: "skip", args: ["1", { reason: "location", note: null }], method: "POST", key: "reviewSkip", body: { ok: true } },
  { fn: "confirmInjection", args: ["1"], method: "POST", key: "reviewConfirmInjection", body: { ok: true } },
];

describe("web client = API_CONTRACT", () => {
  const contract = new Set(apiEndpoints().map((e) => label(e.method, e.key)));
  const found = calls();

  it("calls no route outside the contract", () => {
    expect(found.length).toBeGreaterThan(40);
    expect(found.filter((c) => !contract.has(label(c.method, c.key))).map((c) => `${c.file}: ${label(c.method, c.key)}`)).toEqual([]);
  });

  it("calls every contract route (SSE and the file viewer through their own helpers), or says why not", () => {
    const called = new Set(found.map((c) => label(c.method, c.key)));
    called.add("GET events"); // lib/api/react.tsx: createLiveEventFeed on API_ROUTES.events
    called.add("GET files"); // the shared fileUrl() helper (viewer and its Download)
    const missing = [...contract].filter((k) => !called.has(k) && !UNUSED[k]);
    expect(missing).toEqual([]);
    expect(Object.keys(UNUSED).filter((k) => called.has(k))).toEqual([]);
    expect(readFileSync(join(WEB_ROOT, "lib/api/react.tsx"), "utf8")).toMatch(/API_ROUTES\.events/);
  });

  it("validates each answer with the contract's own response schema", () => {
    const byKey = new Map(apiEndpoints().map((e) => [label(e.method, e.key), e]));
    const wrong = found
      .filter((c) => c.schema !== null)
      .filter((c) => SCHEMAS[c.schema!] !== byKey.get(label(c.method, c.key))?.response)
      .map((c) => `${c.file}: ${label(c.method, c.key)} parses with ${c.schema}`);
    expect(wrong).toEqual([]);
  });

  it("each typed WebApi method sends its contract route", async () => {
    for (const w of WEBAPI) {
      const sent: string[] = [];
      const fetch = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(url).replace("http://orch.test", "").split("?")[0]!;
        sent.push(`${init.method ?? "GET"} ${path}`);
        const body = w.body;
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof globalThis.fetch;
      const api = createHttpApi({ baseUrl: "http://orch.test", fetch, events: { subscribe: () => () => {}, getStatus: () => "idle", onStatus: () => () => {} } });
      await (api[w.fn] as (...a: unknown[]) => Promise<unknown>)(...w.args);
      const route = API_ROUTES[w.key].replace(/:[A-Za-z]+/g, "1");
      expect(sent, w.fn).toContain(`${w.method} ${route}`);
      expect(contract.has(label(w.method, w.key)), w.fn).toBe(true);
    }
  });
});

describe("mock backend = API_CONTRACT", () => {
  it("serves only contract routes, with the contract's response schema", () => {
    const byKey = new Map(apiEndpoints().map((e) => [label(e.method, e.path), e]));
    const wrong = MOCK_ROUTES.filter((r) => {
      const e = byKey.get(label(r.method, r.route));
      return !e || r.response !== e.response;
    }).map((r) => label(r.method, KEY_BY_PATH.get(r.route) ?? r.route));
    expect(wrong).toEqual([]);
  });

  it("serves every route the web app calls (a MOCK_ROUTES entry or a typed WebApi method it implements)", () => {
    const mock = testMock();
    const served = new Set(MOCK_ROUTES.map((r) => label(r.method, KEY_BY_PATH.get(r.route)!)));
    for (const w of WEBAPI) if (typeof (mock as unknown as Record<string, unknown>)[w.fn] === "function") served.add(label(w.method, w.key));
    const needed = new Set(calls().map((c) => label(c.method, c.key)));
    expect([...needed].filter((k) => !served.has(k))).toEqual([]);
    // Every contract key has a row (the type guarantees it; this keeps the import honest).
    expect(Object.keys(API_CONTRACT).length).toBe(Object.keys(API_ROUTES).length);
  });
});
