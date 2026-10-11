// Live run 1: "Resume now" on the paused banner (POST /engines/:engine/resume → engine.resumeEngineNow),
// e.g. after Ba switched Claude accounts. Lifts the usage-limit pause early, releases the held tasks
// and emits engine.resumed. A state change: same Origin/CSRF rules as every other mutation (S18).
import { API_ROUTES, ApiErrorSchema, EnginesResponseSchema, OkResponseSchema } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getEngineState } from "../../db/index.js";
import { fake } from "../../engine/testing/index.js";
import { WEB_ORIGIN, TEST_HOST, createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const resume = (engine: string) => API_ROUTES.engineResume.replace(":engine", engine);

/** A run whose Codex task hit the usage limit: Codex is paused for 90 minutes and its task held. */
async function codexPaused(): Promise<ApiHarness> {
  h = await createApiHarness();
  h.t.runner.script({ bot: "research", kind: "fit", times: 1, result: fake.usageLimit("codex", new Date(h.t.clock.now().getTime() + 90 * 60_000).toISOString()) });
  await h.post("/runs", { workflow: "job-scan", params: { searchProfileId: null, overrides: null } });
  await h.t.idle();
  expect(getEngineState(h.t.db, "codex").reason).toBe("usage_limit");
  return h;
}

describe("POST /engines/:engine/resume (Resume now)", () => {
  it("lifts the pause: the held task runs, engine.resumed is emitted, GET /engines shows it running", async () => {
    const x = await codexPaused();
    expect(x.t.tasks("research.fit")[0]?.status).toBe("waiting_limit");
    const res = await x.post(resume("codex"), {});
    expect(res.statusCode).toBe(200);
    expect(OkResponseSchema.parse(res.json())).toEqual({ ok: true });
    await x.t.idle();
    expect(x.t.events("engine.resumed")).toEqual([expect.objectContaining({ engine: "codex" })]);
    expect(x.t.tasks("research.fit")[0]?.status).toBe("done");
    const engines = EnginesResponseSchema.parse((await x.get("/engines")).json()).engines;
    expect(engines.find((e) => e.engine === "codex")).toMatchObject({ pausedUntil: null, reason: null });
  });

  it("an engine that is not paused is a conflict (409); an unknown engine 404", async () => {
    h = await createApiHarness();
    const res = await h.post(resume("claude"), {});
    expect(res.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(res.json()).error.code).toBe("conflict");
    expect((await h.post(resume("gemini"), {})).statusCode).toBe(404);
  });

  it("is a state change: refused without the CSRF header (S18), and the engine stays paused", async () => {
    const x = await codexPaused();
    const res = await x.app.inject({ method: "POST", url: resume("codex"), headers: { host: TEST_HOST, origin: WEB_ORIGIN } });
    expect(res.statusCode).toBe(403);
    expect(getEngineState(x.t.db, "codex").reason).toBe("usage_limit");
  });
});
