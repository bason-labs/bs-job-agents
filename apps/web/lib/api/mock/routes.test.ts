// Parity of the mock orchestrator's REST routes with the shared contract: every route is a real
// API_ROUTES entry, every answer parses with the shared response schema the orchestrator uses, and
// errors carry the orchestrator's codes.
import { API_ROUTES, AppEventSchema, type AppEvent } from "@bs-job-agents/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isApiError } from "../errors";
import type { MockBackend } from "./backend";
import { MOCK_ROUTES, handleMockRequest, type MockRoute } from "./routes";
import { testMock } from "./testing";

let mock: MockBackend;
let events: AppEvent[];

beforeEach(() => {
  mock = testMock();
  events = [];
  mock.subscribe((e) => events.push(e));
});

afterEach(async () => {
  await mock.idle();
  for (const e of events) expect(AppEventSchema.safeParse(e).success, e.type).toBe(true);
});

const ROUTE_VALUES = new Set<string>(Object.values(API_ROUTES));
const key = (r: Pick<MockRoute, "method" | "route">) => `${r.method} ${r.route}`;

/** A valid call for each route (params and bodies from the seed). */
const CALLS: Record<string, { params?: Record<string, string>; body?: unknown; query?: Record<string, string> }> = {
  [`GET ${API_ROUTES.roomMessages}`]: { params: { id: "cv-brainstorm" }, query: { limit: "2" } },
  [`POST ${API_ROUTES.rooms}`]: { body: { name: "parity-room", members: ["qa"] } },
  [`POST ${API_ROUTES.chatSend}`]: { body: { roomId: "cv-brainstorm", text: "@QA parity?", uploadIds: [] } },
  [`GET ${API_ROUTES.application}`]: { params: { id: "app_1" } },
  [`POST ${API_ROUTES.applicationStatus}`]: { params: { id: "app_1" }, body: { status: "interviewing", note: null } },
  [`POST ${API_ROUTES.applicationApplyAgain}`]: { params: { id: "app_4" } },
  [`POST ${API_ROUTES.exports}`]: { body: {} },
  [`DELETE ${API_ROUTES.savedAnswer}`]: { params: { key: "notice period" } },
  [`GET ${API_ROUTES.schedule}`]: { params: { id: "sch_1" } },
  [`PATCH ${API_ROUTES.schedule}`]: { params: { id: "sch_1" }, body: { enabled: false } },
  [`POST ${API_ROUTES.schedules}`]: { body: { name: "Parity", cron: "0 8 * * *", searchProfileId: null } },
  [`POST ${API_ROUTES.scheduleRunNow}`]: { params: { id: "sch_1" } },
  [`GET ${API_ROUTES.bot}`]: { params: { name: "cv" } },
  [`PATCH ${API_ROUTES.bot}`]: { params: { name: "research" }, body: { enabled: false } },
  [`POST ${API_ROUTES.botPromotionDismiss}`]: { params: { name: "apply" } },
  [`POST ${API_ROUTES.masterCvFactRequestDismiss}`]: { params: { id: "2102-0" } },
  [`POST ${API_ROUTES.workflowProposalApprove}`]: { params: { id: "6f1c2a52-8d0b-4c56-9a7e-2b1f0c9d4e11" } },
};

describe("mock routes: parity with the shared API", () => {
  it("serves only real API_ROUTES entries, each once per method", () => {
    for (const r of MOCK_ROUTES) expect(ROUTE_VALUES.has(r.route), key(r)).toBe(true);
    const keys = MOCK_ROUTES.map(key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers every route the W3c screens call", () => {
    const needed = [
      `GET ${API_ROUTES.applications}`,
      `GET ${API_ROUTES.application}`,
      `POST ${API_ROUTES.applicationStatus}`,
      `POST ${API_ROUTES.applicationApplyAgain}`,
      `POST ${API_ROUTES.exports}`,
      `GET ${API_ROUTES.criteria}`,
      `PUT ${API_ROUTES.criteria}`,
      `GET ${API_ROUTES.criteriaVersions}`,
      `GET ${API_ROUTES.criteriaProfiles}`,
      `GET ${API_ROUTES.savedAnswers}`,
      `DELETE ${API_ROUTES.savedAnswer}`,
      `GET ${API_ROUTES.schedules}`,
      `POST ${API_ROUTES.schedules}`,
      `PATCH ${API_ROUTES.schedule}`,
      `DELETE ${API_ROUTES.schedule}`,
      `POST ${API_ROUTES.scheduleRestore}`,
      `POST ${API_ROUTES.scheduleRunNow}`,
      `GET ${API_ROUTES.bots}`,
      `GET ${API_ROUTES.bot}`,
      `PATCH ${API_ROUTES.bot}`,
      `DELETE ${API_ROUTES.botMemoryNote}`,
      `POST ${API_ROUTES.botPromotionDismiss}`,
      `GET ${API_ROUTES.masterCv}`,
      `PUT ${API_ROUTES.masterCv}`,
      `GET ${API_ROUTES.masterCvVersions}`,
      `GET ${API_ROUTES.masterCvFactRequests}`,
      `POST ${API_ROUTES.masterCvFactRequestDismiss}`,
      `GET ${API_ROUTES.workflowProposals}`,
      `POST ${API_ROUTES.workflowProposalApprove}`,
      `POST ${API_ROUTES.workflowProposalDismiss}`,
      `GET ${API_ROUTES.rooms}`,
      `POST ${API_ROUTES.rooms}`,
      `GET ${API_ROUTES.roomMessages}`,
      `POST ${API_ROUTES.chatSend}`,
    ];
    const served = new Set(MOCK_ROUTES.map(key));
    expect(needed.filter((k) => !served.has(k))).toEqual([]);
  });

  it("answers every parameterless GET and every scripted call with its shared response schema", async () => {
    for (const r of MOCK_ROUTES) {
      const call = CALLS[key(r)];
      if (!call && (r.method !== "GET" || r.route.includes(":"))) continue;
      const out = await handleMockRequest(mock, r.method, r.route, call ?? {});
      if (r.response) {
        const parsed = r.response.safeParse(out);
        expect(parsed.success, `${key(r)}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 2))}`).toBe(true);
      }
    }
  });

  it("answers unknown routes and ids like the orchestrator (404 not_found)", async () => {
    const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
    const unknownRoute = await err(handleMockRequest(mock, "GET", "/nope"));
    expect(isApiError(unknownRoute) && unknownRoute.code).toBe("not_found");
    for (const [method, route, params] of [
      ["GET", API_ROUTES.application, { id: "9999" }],
      ["GET", API_ROUTES.bot, { name: "nobody" }],
      ["GET", API_ROUTES.schedule, { id: "9999" }],
      ["GET", API_ROUTES.roomMessages, { id: "9999" }],
    ] as const) {
      const e = await err(handleMockRequest(mock, method, route, { params }));
      expect(isApiError(e) && e.status, `${method} ${route}`).toBe(404);
    }
  });

  it("validates bodies with the shared request schemas (400 validation_failed)", async () => {
    const e = await handleMockRequest(mock, "PATCH", API_ROUTES.bot, { params: { name: "qa" }, body: { trustLevel: 7 } }).catch((x: unknown) => x);
    expect(isApiError(e) && [e.status, e.code]).toEqual([400, "validation_failed"]);
  });
});
