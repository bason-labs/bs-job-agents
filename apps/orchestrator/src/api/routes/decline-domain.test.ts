// Phase 3 QA: UC-11 e "Don't allow" (POST /tasks/:id/decline-domain → engine.declineDomain). Ba
// declines the site Apply paused at: Apply ends, the application needs a check, the token's
// domains are not widened, and a safety event is logged.
import { API_ROUTES, ApiErrorSchema, OkResponseSchema, ReviewQueueResponseSchema } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getApplication, getTask, latestApprovalForApplication } from "../../db/index.js";
import { fake } from "../../engine/testing/index.js";
import { WEB_ORIGIN, TEST_HOST, createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const decline = (id: string | number) => API_ROUTES.taskDeclineDomain.replace(":id", String(id));

/** Approve the card; Apply pauses for an off-site ATS domain. */
async function pausedAtAts(): Promise<{ x: ApiHarness; taskId: number; applicationId: number }> {
  h = await createApiHarness();
  await h.post("/runs", { workflow: "job-scan", params: { searchProfileId: null, overrides: null } });
  await h.t.idle();
  const [card] = ReviewQueueResponseSchema.parse((await h.get("/review")).json()).cards;
  h.t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyDomainConfirm("novapay.breezy.hr") });
  const res = (await h.post(`/review/${card!.job.id}/approve`, { cvVersionId: card!.cvOptions[0]!.cvVersion.id, introText: null })).json();
  await h.t.idle();
  const taskId = Number(res.taskId);
  expect(getTask(h.t.db, taskId)).toMatchObject({ status: "paused", pauseReason: "domain_confirm(novapay.breezy.hr)" });
  return { x: h, taskId, applicationId: Number(res.applicationId) };
}

describe("POST /tasks/:id/decline-domain (UC-11 e Don't allow)", () => {
  it("ends Apply through the engine: needs_check, token not widened, safety event", async () => {
    const { x, taskId, applicationId } = await pausedAtAts();
    const res = await x.post(decline(taskId), {});
    expect(res.statusCode).toBe(200);
    expect(OkResponseSchema.parse(res.json())).toEqual({ ok: true });
    await x.t.idle();
    expect(getTask(x.t.db, taskId)).toMatchObject({ status: "failed" });
    expect(getApplication(x.t.db, applicationId)?.status).toBe("needs_check");
    expect(latestApprovalForApplication(x.t.db, applicationId)!.allowedDomains).toEqual(["itviec.com"]);
    expect(x.t.events("safety.denied").at(-1)).toMatchObject({ action: "apply.domain_confirm", reason: "off_allowlist" });
    expect(x.t.runner.callsFor("apply.submit")).toHaveLength(1);
  });

  it("a task that is not waiting for a domain is a conflict (409); an unknown or malformed task id 404", async () => {
    const { x, taskId } = await pausedAtAts();
    expect((await x.post(decline(taskId), {})).statusCode).toBe(200);
    await x.t.idle();
    const again = await x.post(decline(taskId), {});
    expect(again.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(again.json()).error.code).toBe("conflict");
    expect((await x.post(decline(999), {})).statusCode).toBe(404);
    expect((await x.post(decline("abc"), {})).statusCode).toBe(404);
  });

  it("is a state change: refused without the CSRF header (S18), and Apply stays paused", async () => {
    const { x, taskId } = await pausedAtAts();
    const res = await x.app.inject({ method: "POST", url: decline(taskId), headers: { host: TEST_HOST, origin: WEB_ORIGIN } });
    expect(res.statusCode).toBe(403);
    expect(getTask(x.t.db, taskId)?.status).toBe("paused");
  });
});
