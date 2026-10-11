// Owner request 2026-10-11: facts from Ba's own words on the Master CV screen.
//   POST /master-cv/facts/draft → 202 { taskId }; CV's cv.fact_draft runs (FakeRunner here); the facts
//   are checked and appended as a new master version (history kept), the request is closed, and
//   master_cv.updated is emitted. GET /master-cv/facts/draft/:taskId reads the result.
//   POST /master-cv/facts/undo restores the version before, only while it is the latest change.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ApiErrorSchema,
  CSRF_HEADER,
  FACT_DRAFT_SELF_CHECK,
  FactDraftStartedSchema,
  FactDraftViewSchema,
  FactRequestsResponseSchema,
  MasterCvSchema,
  type FactDraftOutput,
} from "@bs-job-agents/shared";
import { factDraftNoneFixture, factDraftOutputFixture, masterCvFixture } from "@bs-job-agents/shared/fixtures";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { getTask } from "../../db/index.js";
import type { RunnerTask } from "../../runner/types.js";
import { defaultFakeResult, fake } from "../../engine/testing/fake-runner.js";
import { createApiHarness, TEST_HOST, WEB_ORIGIN, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const AWS_REQUEST = { topic: "AWS", question: "Have you deployed on AWS?", reason: "The JD asks for AWS deployments" };
const ANSWER = "Yes, at Gradion I deployed our Next.js apps to AWS ECS with Terraform.";

/** A harness with Ba's master CV (v1) and a job whose CV asked about AWS (its run waits at review). */
async function setup(): Promise<{ h: ApiHarness; requestId: string; jobId: string }> {
  const harness = await createApiHarness();
  expect((await harness.put("/master-cv", { ...masterCvFixture, version: 1 })).statusCode).toBe(200);
  harness.t.runner.script({
    bot: "cv",
    kind: "tailor",
    times: 1,
    result: (task: RunnerTask) => {
      const r = defaultFakeResult(task);
      return r.status === "ok" ? { ...r, output: { ...(r.output as object), factRequests: [AWS_REQUEST] } } : r;
    },
  });
  harness.t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
  await harness.t.idle();
  const requests = FactRequestsResponseSchema.parse((await harness.get("/master-cv/fact-requests")).json()).requests;
  expect(requests).toHaveLength(1);
  return { h: harness, requestId: requests[0]!.id, jobId: requests[0]!.jobId };
}

async function draft(harness: ApiHarness, body: Record<string, unknown>) {
  const res = await harness.post("/master-cv/facts/draft", body);
  expect(res.statusCode, res.body).toBe(202);
  const { taskId } = FactDraftStartedSchema.parse(res.json());
  await harness.t.idle();
  return { taskId, view: FactDraftViewSchema.parse((await harness.get(`/master-cv/facts/draft/${taskId}`)).json()) };
}

const masterOnDisk = (harness: ApiHarness) => MasterCvSchema.parse(parse(readFileSync(join(harness.dataDir, "master-cv.yaml"), "utf8")));
const withSelfCheck = (out: Omit<FactDraftOutput, "selfCheck">): FactDraftOutput => ({ ...out, selfCheck: FACT_DRAFT_SELF_CHECK.map((item) => ({ item, passed: true, note: null })) });

describe("POST /master-cv/facts/draft (owner request 2026-10-11)", () => {
  it("answers a fact request in Ba's words: the fact is added as a new version, the request closes, the job can be re-tailored", async () => {
    const s = await setup();
    h = s.h;
    const { taskId, view } = await draft(h, { text: ANSWER, factRequestId: s.requestId, version: 1 });
    // CV got Ba's words, the question and his facts' ids/orgs/dates, nothing else.
    expect(h.t.runner.callsFor("cv.fact_draft")[0]!.input).toEqual({
      text: ANSWER,
      question: { ...AWS_REQUEST, company: "NovaPay" },
      existingFacts: masterCvFixture.facts.map((f) => ({ id: f.id, type: f.type, org: f.org, dates: f.dates })),
      masterCvVersion: 1,
    });
    expect(view).toMatchObject({ taskId, status: "added", version: 2, previousVersion: 1, factRequestId: s.requestId, undoable: true, undone: false, error: null, rejected: [] });
    expect(view.facts).toEqual([
      { id: "grad-2", type: "experience", text: "At Gradion I deployed our Next.js apps to AWS ECS with Terraform.", textVi: "at Gradion I deployed our Next.js apps to AWS ECS with Terraform.", tags: ["aws"], org: "Gradion", dates: "2022 – present" },
    ]);
    const disk = masterOnDisk(h);
    expect(disk.version).toBe(2);
    expect(disk.facts.map((f) => f.id)).toEqual(["grad-1", "skill-1", "grad-2"]);
    expect(existsSync(join(h.dataDir, "master-cv-history", "v1.yaml"))).toBe(true);
    expect(existsSync(join(h.dataDir, "master-cv-history", "v2.yaml"))).toBe(true);
    expect(FactRequestsResponseSchema.parse((await h.get("/master-cv/fact-requests")).json()).requests).toEqual([]);
    expect(h.t.events("master_cv.updated").at(-1)).toMatchObject({ version: 2, change: "facts_added", factIds: ["grad-2"], taskId });
    expect(h.t.delivered().some((e) => e.type === "master_cv.updated" && e.change === "facts_added")).toBe(true);
    // Re-tailor: the job's CV step in its run; re-running it tailors again.
    const tailorStep = String(h.t.tasks("cv.tailor")[0]!.stepId);
    expect(view.retailor).toEqual({ jobId: s.jobId, company: "NovaPay", stepIds: [tailorStep], note: null });
    expect((await h.post(`/steps/${tailorStep}/rerun`, {})).statusCode).toBe(200);
    await h.t.idle();
    expect(h.t.tasks("cv.tailor")).toHaveLength(2);
  });

  it("the free-text box adds facts with no request and no re-tailor; ids already taken are renamed", async () => {
    h = await createApiHarness();
    await h.put("/master-cv", { ...masterCvFixture, version: 1 });
    h.t.runner.script({ bot: "cv", kind: "fact_draft", result: fake.ok(withSelfCheck({ ...factDraftOutputFixture, facts: [{ ...factDraftOutputFixture.facts[0]!, id: "grad-1" }] })) });
    // A plain save is announced too (other tabs and screens re-read).
    expect(h.t.events("master_cv.updated")).toEqual([expect.objectContaining({ version: 1, change: "saved", factIds: [], taskId: null })]);
    const { view } = await draft(h, { text: ANSWER, version: 1 });
    expect(view).toMatchObject({ status: "added", factRequestId: null, retailor: null });
    expect(view.facts.map((f) => f.id)).toEqual(["grad-2"]);
    expect(h.t.runner.callsFor("cv.fact_draft")[0]!.input).toMatchObject({ question: null });
  });

  it("Ba says no: nothing is added, CV's note is shown, the request stays open", async () => {
    const s = await setup();
    h = s.h;
    h.t.runner.script({ bot: "cv", kind: "fact_draft", result: fake.ok(factDraftNoneFixture) });
    const { view } = await draft(h, { text: "No, I haven't.", factRequestId: s.requestId, version: 1 });
    expect(view).toMatchObject({ status: "no_facts", facts: [], notes: factDraftNoneFixture.notes, version: null, undoable: false, retailor: null });
    expect(masterOnDisk(h).version).toBe(1);
    expect(FactRequestsResponseSchema.parse((await h.get("/master-cv/fact-requests")).json()).requests.map((r) => r.id)).toEqual([s.requestId]);
  });

  it("a drafted fact with a number Ba did not give is rejected, never added", async () => {
    h = await createApiHarness();
    await h.put("/master-cv", { ...masterCvFixture, version: 1 });
    const invented = { ...factDraftOutputFixture.facts[0]!, text: "Cut AWS costs by 40% at Gradion." };
    h.t.runner.script({ bot: "cv", kind: "fact_draft", result: fake.ok(withSelfCheck({ ...factDraftOutputFixture, facts: [invented] })) });
    const { view } = await draft(h, { text: ANSWER, version: 1 });
    expect(view).toMatchObject({ status: "no_facts", facts: [], rejected: [{ id: "grad-2", text: invented.text, reasons: ["the number 40 is not in your words"] }] });
    expect(masterOnDisk(h).version).toBe(1);
  });

  it("a CV task that fails for good shows as failed, and nothing changes", async () => {
    h = await createApiHarness();
    await h.put("/master-cv", { ...masterCvFixture, version: 1 });
    h.t.runner.script({ bot: "cv", kind: "fact_draft", result: fake.timeout() });
    const { taskId, view } = await draft(h, { text: ANSWER, version: 1 });
    expect(view).toMatchObject({ status: "failed", error: "timed out", facts: [] });
    expect(getTask(h.t.db, Number(taskId))?.status).toBe("failed");
    expect(masterOnDisk(h).version).toBe(1);
  });

  it("refuses a stale version (409 master_cv_changed), a missing master CV, an unknown request and empty text; nothing is queued", async () => {
    h = await createApiHarness();
    const missing = await h.post("/master-cv/facts/draft", { text: ANSWER, version: 1 });
    expect(missing.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(missing.json()).error.details).toMatchObject({ reason: "master_cv_missing" });
    await h.put("/master-cv", { ...masterCvFixture, version: 1 });
    await h.put("/master-cv", { ...masterCvFixture, version: 1 });
    const stale = await h.post("/master-cv/facts/draft", { text: ANSWER, version: 1 });
    expect(stale.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(stale.json()).error.details).toMatchObject({ reason: "master_cv_changed", currentVersion: 2 });
    expect((await h.post("/master-cv/facts/draft", { text: ANSWER, factRequestId: "999-0", version: 2 })).statusCode).toBe(404);
    expect((await h.post("/master-cv/facts/draft", { text: "  ", version: 2 })).statusCode).toBe(400);
    expect((await h.post("/master-cv/facts/draft", { text: ANSWER, version: 2, extra: true })).statusCode).toBe(400);
    expect(h.t.tasks("cv.fact_draft")).toEqual([]);
    expect((await h.get("/master-cv/facts/draft/12345")).statusCode).toBe(404);
  });

  it("is a CSRF-guarded mutation like the others (S18)", async () => {
    h = await createApiHarness();
    await h.put("/master-cv", { ...masterCvFixture, version: 1 });
    const noHeader = await h.app.inject({ method: "POST", url: "/master-cv/facts/draft", headers: { host: TEST_HOST, origin: WEB_ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ text: ANSWER, version: 1 }) });
    expect(noHeader.statusCode).toBe(403);
    const foreign = await h.app.inject({ method: "POST", url: "/master-cv/facts/undo", headers: { host: TEST_HOST, origin: "https://evil.example", [CSRF_HEADER]: "1", "content-type": "application/json" }, payload: JSON.stringify({ version: 1 }) });
    expect(foreign.statusCode).toBe(403);
    expect(h.t.tasks("cv.fact_draft")).toEqual([]);
  });
});

describe("POST /master-cv/facts/undo", () => {
  it("restores the version before as a new version and reopens the request; only once, only while it is the latest change", async () => {
    const s = await setup();
    h = s.h;
    const { taskId } = await draft(h, { text: ANSWER, factRequestId: s.requestId, version: 1 });
    const res = await h.post("/master-cv/facts/undo", { version: 2 });
    expect(res.statusCode, res.body).toBe(200);
    const restored = MasterCvSchema.parse(res.json());
    expect(restored.version).toBe(3);
    expect(restored.facts).toEqual(MasterCvSchema.parse(masterCvFixture).facts);
    expect(masterOnDisk(h)).toEqual(restored);
    expect(h.t.events("master_cv.updated").at(-1)).toMatchObject({ version: 3, change: "undo", factIds: ["grad-2"], taskId });
    expect(FactRequestsResponseSchema.parse((await h.get("/master-cv/fact-requests")).json()).requests.map((r) => r.id)).toEqual([s.requestId]);
    const view = FactDraftViewSchema.parse((await h.get(`/master-cv/facts/draft/${taskId}`)).json());
    expect(view).toMatchObject({ undone: true, undoable: false, retailor: null });
    const again = await h.post("/master-cv/facts/undo", { version: 3 });
    expect(again.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(again.json()).error.details).toMatchObject({ reason: "not_undoable" });
  });

  it("refuses once the master CV changed after the addition (409 master_cv_changed)", async () => {
    h = await createApiHarness();
    await h.put("/master-cv", { ...masterCvFixture, version: 1 });
    await draft(h, { text: ANSWER, version: 1 });
    await h.put("/master-cv", { ...masterOnDisk(h), version: 2 });
    const res = await h.post("/master-cv/facts/undo", { version: 2 });
    expect(res.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(res.json()).error.details).toMatchObject({ reason: "master_cv_changed", currentVersion: 3 });
    expect(masterOnDisk(h).facts.map((f) => f.id)).toContain("grad-2");
  });
});
