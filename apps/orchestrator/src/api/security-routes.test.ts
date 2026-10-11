// Phase 3 QA (PM S18): the request checks on every real route of the contract, not only on the toy
// app of security.test.ts. A route registered outside the global hook would fail here.
// - any route: a foreign Host (DNS rebinding) is refused;
// - a state change: no CSRF header, a foreign Origin, or Sec-Fetch-Site: cross-site is refused,
//   and nothing changes in the database.
import { CSRF_HEADER, CSRF_HEADER_VALUE, apiEndpoints } from "@bs-job-agents/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listApplications, listEvents, listRuns, listTasks } from "../db/index.js";
import { TEST_HOST, WEB_ORIGIN, createApiHarness, type ApiHarness } from "./testing.js";

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness();
});
afterAll(async () => {
  await h.close();
});

const url = (path: string) => path.replace(/:[A-Za-z]+/g, "1");
const MUTATIONS = apiEndpoints().filter((e) => e.method !== "GET");

function snapshot() {
  return { runs: listRuns(h.t.db).length, tasks: listTasks(h.t.db).length, applications: listApplications(h.t.db).length, events: listEvents(h.t.db).length };
}

describe("S18 on every route of the contract", () => {
  it("refuses a foreign Host on every route (DNS rebinding), GET included", async () => {
    const offenders: string[] = [];
    for (const e of apiEndpoints()) {
      const res = await h.app.inject({ method: e.method, url: url(e.path), headers: { host: "evil.example:4100", origin: WEB_ORIGIN, [CSRF_HEADER]: CSRF_HEADER_VALUE, "content-type": "application/json" }, payload: e.method === "GET" ? undefined : "{}" });
      if (res.statusCode !== 403) offenders.push(`${e.method} ${e.path} → ${res.statusCode}`);
    }
    expect(offenders).toEqual([]);
  });

  it("refuses every state change without the CSRF header, from a foreign Origin, or cross-site; nothing changes", async () => {
    const before = snapshot();
    const offenders: string[] = [];
    const attempts: Array<[string, Record<string, string>]> = [
      ["no CSRF header", { host: TEST_HOST, origin: WEB_ORIGIN }],
      ["foreign Origin", { host: TEST_HOST, origin: "https://evil.example", [CSRF_HEADER]: CSRF_HEADER_VALUE }],
      ["cross-site", { host: TEST_HOST, "sec-fetch-site": "cross-site", [CSRF_HEADER]: CSRF_HEADER_VALUE }],
    ];
    for (const e of MUTATIONS) {
      for (const [why, headers] of attempts) {
        const res = await h.app.inject({ method: e.method, url: url(e.path), headers: { ...headers, "content-type": "application/json" }, payload: "{}" });
        if (res.statusCode !== 403) offenders.push(`${e.method} ${e.path} (${why}) → ${res.statusCode}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(MUTATIONS.length).toBeGreaterThan(30);
    expect(snapshot()).toEqual(before);
  });

  it("a cross-site HTML form (urlencoded, no custom header) can never reach a mutation", async () => {
    for (const e of MUTATIONS) {
      const res = await h.app.inject({
        method: "POST",
        url: url(e.path),
        headers: { host: TEST_HOST, origin: "null", "content-type": "application/x-www-form-urlencoded" },
        payload: "a=1",
      });
      expect([403, 404], `${e.method} ${e.path}`).toContain(res.statusCode);
    }
  });
});
