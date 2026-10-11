import { FactDraftViewSchema, FactRequestsResponseSchema, MasterCvVersionsResponseSchema } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { apiErrorInfo, errorDetails } from "@/components/schedules/apiError";
import { createHttpApi } from "@/lib/api/http";
import { MASTER_CV } from "@/lib/api/mock/seed-master-cv";
import type { MockMasterCv } from "@/lib/api/mock/state";
import { testMock } from "@/lib/api/mock/testing";
import { createMasterCvData, type MasterCvData } from "./data";

const make = (file?: MockMasterCv) => createMasterCvData(testMock({ state: (s) => void (file && (s.masterCv = file)) }));

async function current(data: MasterCvData) {
  const read = await data.get();
  if (read.state !== "ok") throw new Error(`expected a master CV, got ${read.state}`);
  return read.cv;
}

describe("master CV adapter (GET/PUT /master-cv, /versions, /fact-requests)", () => {
  it("reads the master CV", async () => {
    expect(await make().get()).toEqual({ state: "ok", cv: MASTER_CV });
  });

  it("saves a new version and records it in the history, newest first", async () => {
    const data = make();
    const cv = await current(data);
    cv.facts[0]!.text += " Shipped weekly.";
    const saved = await data.save(cv);
    expect(saved.version).toBe(8);
    expect(saved.facts[0]!.text).toMatch(/Shipped weekly\.$/);
    const versions = await data.versions();
    expect(MasterCvVersionsResponseSchema.safeParse({ versions }).success).toBe(true);
    expect(versions[0]).toEqual({ version: 8, savedAt: "2026-10-11T03:00:00.000Z", factCount: 7 });
  });

  it("refuses a save based on an older version (409 master_cv_changed with currentVersion)", async () => {
    const data = make();
    const mine = await current(data);
    const other = await current(data);
    await data.save({ ...other, facts: other.facts.slice(1) }); // another tab saves v8
    const refused = await data.save(mine).catch((e: unknown) => e);
    expect(apiErrorInfo(refused)).toMatchObject({ status: 409, code: "conflict", reason: "master_cv_changed" });
    expect(errorDetails(refused)).toMatchObject({ currentVersion: 8 });
  });

  it("maps 404 to missing, and the first save creates version 1", async () => {
    const data = make({ kind: "missing" });
    expect(await data.get()).toEqual({ state: "missing" });
    expect((await data.save({ ...MASTER_CV, version: 1 })).version).toBe(1);
    expect((await data.get()).state).toBe("ok");
  });

  it("maps 409 master_cv_invalid to invalid, with the server's message", async () => {
    const read = await make({ kind: "invalid", detail: "facts.2.id: fact ids are lowercase slugs" }).get();
    expect(read).toEqual({ state: "invalid", detail: "data/master-cv.yaml cannot be read: facts.2.id: fact ids are lowercase slugs" });
  });

  it("rejects invalid master data (duplicate fact ids) with 400", async () => {
    const data = make();
    const cv = await current(data);
    expect(apiErrorInfo(await data.save({ ...cv, facts: [...cv.facts, cv.facts[0]!] }).catch((e: unknown) => e))).toMatchObject({ status: 400 });
  });

  it("lists CV's open fact requests and closes one (404 once closed)", async () => {
    const data = make();
    const requests = await data.factRequests();
    expect(FactRequestsResponseSchema.safeParse({ requests }).success).toBe(true);
    expect(requests[0]).toMatchObject({ id: "2102-0", topic: "GraphQL", company: "NovaPay" });
    await data.dismissFactRequest("2102-0");
    expect((await data.factRequests()).map((r) => r.id)).not.toContain("2102-0");
    expect(apiErrorInfo(await data.dismissFactRequest("2102-0").catch((e: unknown) => e))).toMatchObject({ status: 404 });
  });

  it("drafts facts from Ba's words, polls until CV settles, and undoes them (owner request 2026-10-11)", async () => {
    const mock = testMock();
    const data = createMasterCvData(mock, { pollMs: 1 });
    const { taskId } = await data.draftFacts({ text: "Yes, I used GraphQL with Apollo Client at Aegona.", factRequestId: "2102-0", version: 7 });
    const view = await data.awaitFactDraft(taskId);
    expect(FactDraftViewSchema.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({ status: "added", version: 8, previousVersion: 7, factRequestId: "2102-0", undoable: true });
    expect(view.facts.map((f) => f.id)).toEqual(["aeg-2"]);
    expect(view.retailor).toMatchObject({ jobId: "101", company: "NovaPay", note: null });
    expect(view.retailor!.stepIds.length).toBeGreaterThan(0);
    expect((await current(data)).version).toBe(8);
    expect((await data.factRequests()).map((r) => r.id)).not.toContain("2102-0");
    const restored = await data.undoFacts(8);
    expect(restored.version).toBe(9);
    expect(restored.facts.map((f) => f.id)).not.toContain("aeg-2");
    expect((await data.factRequests()).map((r) => r.id)).toContain("2102-0");
    expect(await data.factDraft(taskId)).toMatchObject({ undone: true, undoable: false, retailor: null });
    expect(apiErrorInfo(await data.undoFacts(9).catch((e: unknown) => e))).toMatchObject({ status: 409, reason: "not_undoable" });
    await mock.idle();
  });

  it("refuses a draft from a stale page (409 master_cv_changed), an unknown request (404) and empty text (400)", async () => {
    const data = make();
    expect(errorDetails(await data.draftFacts({ text: "x", factRequestId: null, version: 6 }).catch((e: unknown) => e))).toMatchObject({ reason: "master_cv_changed", currentVersion: 7 });
    expect(apiErrorInfo(await data.draftFacts({ text: "x", factRequestId: "9-9", version: 7 }).catch((e: unknown) => e))).toMatchObject({ status: 404 });
    expect(apiErrorInfo(await data.draftFacts({ text: " ", factRequestId: null, version: 7 }).catch((e: unknown) => e))).toMatchObject({ status: 400 });
  });

  it("re-runs CV steps and reports each step's problem", async () => {
    const mock = testMock();
    const data = createMasterCvData(mock);
    const run = Object.values(mock.state.runs).find((r) => r.steps.some((s) => s.stepKey === "tailor" && s.status === "done"))!;
    const tailor = run.steps.find((s) => s.stepKey === "tailor" && s.status === "done")!;
    const results = await data.rerunSteps([tailor.id, "nope"]);
    expect(results[tailor.id]).toBeNull();
    expect(results.nope).toMatch(/not found/);
    await mock.idle();
  });

  it("live: the orchestrator's 409 master_cv_invalid body becomes the invalid state", async () => {
    const body = { error: { code: "conflict", message: "data/master-cv.yaml cannot be read: bad yaml", details: { reason: "master_cv_invalid" } } };
    const fetch = async () => new Response(JSON.stringify(body), { status: 409 });
    const api = createHttpApi({ baseUrl: "/api", fetch: fetch as typeof globalThis.fetch, events: { subscribe: () => () => {}, getStatus: () => "idle", onStatus: () => () => {} } });
    expect(await createMasterCvData(api).get()).toEqual({ state: "invalid", detail: "data/master-cv.yaml cannot be read: bad yaml" });
  });
});
