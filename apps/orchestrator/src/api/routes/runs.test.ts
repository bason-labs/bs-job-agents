import {
  ApiErrorSchema,
  OkResponseSchema,
  RunControlResponseSchema,
  RunDetailSchema,
  RunsResponseSchema,
  StartRunResponseSchema,
  StepDetailSchema,
} from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { fake } from "../../engine/testing/index.js";
import { getRun, getStepByKey, getTask, listSteps, listTasks, setTaskTranscriptPath } from "../../db/index.js";
import { createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const scan = { workflow: "job-scan", params: { searchProfileId: null, overrides: null } } as const;

describe("runs (UC-01, UC-22, UC-23)", () => {
  it("POST /runs starts a workflow through the engine; GET /runs lists it newest first", async () => {
    h = await createApiHarness();
    const res = await h.post("/runs", scan);
    expect(res.statusCode).toBe(201);
    const { runId } = StartRunResponseSchema.parse(res.json());
    await h.t.idle();
    expect(getRun(h.t.db, Number(runId))?.trigger).toBe("chat");
    const list = RunsResponseSchema.parse((await h.get("/runs")).json());
    expect(list.runs.map((r) => r.id)).toEqual([runId]);
    expect(RunsResponseSchema.parse((await h.get("/runs?status=done")).json()).runs).toEqual([]);
  });

  it("apply-to-link starts with the link trigger", async () => {
    h = await createApiHarness();
    const res = await h.post("/runs", { workflow: "apply-to-link", params: { url: "https://itviec.com/it-jobs/frontend-1" } });
    expect(res.statusCode).toBe(201);
    expect(getRun(h.t.db, Number(res.json().runId))?.trigger).toBe("link");
    await h.t.idle();
  });

  it("refuses invalid input (400) and maps the engine's refusals (409 with the reason)", async () => {
    h = await createApiHarness();
    const bad = await h.post("/runs", { workflow: "job-scan", params: { maxJobs: 5 } });
    expect(bad.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(bad.json()).error.code).toBe("validation_failed");
    h.t.masterCv.current = null;
    const refused = await h.post("/runs", scan);
    expect(refused.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(refused.json()).error.details).toEqual({ reason: "master_cv_missing" });
  });

  it("GET /runs/:id has the run, its steps and its tasks; an unknown or malformed id is 404", async () => {
    h = await createApiHarness();
    const { runId } = (await h.post("/runs", scan)).json();
    await h.t.idle();
    const detail = RunDetailSchema.parse((await h.get(`/runs/${runId}`)).json());
    expect(detail.run.id).toBe(runId);
    expect(detail.steps.map((s) => s.stepKey)).toContain("scan");
    expect(detail.tasks.some((t) => t.botName === "research" && t.kind === "scan")).toBe(true);
    expect((await h.get("/runs/999")).statusCode).toBe(404);
    expect((await h.get("/runs/abc")).statusCode).toBe(404);
    expect((await h.get("/runs/1e3")).statusCode).toBe(404);
  });

  it("never shows a transcript path outside data/", async () => {
    h = await createApiHarness();
    const { runId } = (await h.post("/runs", scan)).json();
    await h.t.idle();
    const task = listTasks(h.t.db, { runId: Number(runId) })[0]!;
    setTaskTranscriptPath(h.t.db, task.id, "/Users/bason/.ssh/id_ed25519");
    const other = listTasks(h.t.db, { runId: Number(runId) })[1]!;
    setTaskTranscriptPath(h.t.db, other.id, "../../etc/passwd");
    const detail = RunDetailSchema.parse((await h.get(`/runs/${runId}`)).json());
    expect(detail.tasks.find((t) => t.id === String(task.id))?.transcriptPath).toBeNull();
    expect(detail.tasks.find((t) => t.id === String(other.id))?.transcriptPath).toBeNull();
    expect(detail.tasks.some((t) => t.transcriptPath?.startsWith("transcripts/"))).toBe(true);
  });

  it("POST /runs/:id/control pauses, resumes and cancels (UC-23)", async () => {
    h = await createApiHarness();
    h.t.runner.script({ bot: "research", kind: "scan", delayMs: 60_000 });
    const { runId } = (await h.post("/runs", scan)).json();
    await h.t.flush();
    const paused = RunControlResponseSchema.parse((await h.post(`/runs/${runId}/control`, { action: "pause" })).json());
    expect(paused.run.status).toBe("paused");
    const resumed = RunControlResponseSchema.parse((await h.post(`/runs/${runId}/control`, { action: "resume" })).json());
    expect(resumed.run.status).toMatch(/running|waiting/);
    const cancelled = RunControlResponseSchema.parse((await h.post(`/runs/${runId}/control`, { action: "cancel" })).json());
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.abortedTaskIds.length).toBe(1);
    await h.t.idle();
    const again = await h.post(`/runs/${runId}/control`, { action: "pause" });
    expect(again.statusCode).toBe(409);
    expect((await h.post(`/runs/${runId}/control`, { action: "explode" })).statusCode).toBe(400);
    expect((await h.post("/runs/999/control", { action: "pause" })).statusCode).toBe(404);
  });

  it("GET /steps/:id is the step drawer: tasks, self-check and duration (UC-22)", async () => {
    h = await createApiHarness();
    const { runId } = (await h.post("/runs", scan)).json();
    await h.t.idle();
    const step = getStepByKey(h.t.db, Number(runId), "dedupe")!;
    const scanStep = h.t.tasks("research.scan")[0]!.stepId!;
    const detail = StepDetailSchema.parse((await h.get(`/steps/${scanStep}`)).json());
    expect(detail.tasks.length).toBeGreaterThan(0);
    expect(detail.selfCheck.length).toBeGreaterThan(0);
    expect(detail.selfCheck.every((c) => c.passed)).toBe(true);
    const plain = StepDetailSchema.parse((await h.get(`/steps/${step.id}`)).json());
    expect(plain.tasks).toEqual([]);
    expect((await h.get("/steps/999")).statusCode).toBe(404);
  });

  it("POST /steps/:id/rerun re-runs a finished step; Apply and record steps are refused (403)", async () => {
    h = await createApiHarness();
    const { runId } = (await h.post("/runs", scan)).json();
    await h.t.idle();
    // The locked Apply step is not finished: 409 (a finished one is 403, see the review tests).
    const apply = listSteps(h.t.db, Number(runId)).find((s) => s.stepKey === "apply")!;
    expect(apply.status).toBe("locked");
    expect((await h.post(`/steps/${apply.id}/rerun`)).statusCode).toBe(409);
    const dedupe = getStepByKey(h.t.db, Number(runId), "dedupe")!;
    const res = await h.post(`/steps/${dedupe.id}/rerun`);
    expect(res.statusCode).toBe(200);
    expect(OkResponseSchema.parse(res.json())).toEqual({ ok: true });
    await h.t.idle();
    expect((await h.post("/steps/999/rerun")).statusCode).toBe(404);
  });

  it("POST /tasks/:id/resume continues a task paused for a login (UC-17); a running task cannot be resumed", async () => {
    h = await createApiHarness();
    h.t.runner.script({ bot: "research", kind: "scan", times: 1, result: fake.needsLogin("itviec.com") });
    const { runId } = (await h.post("/runs", scan)).json();
    await h.t.idle();
    const task = h.t.tasks("research.scan")[0]!;
    expect(getTask(h.t.db, task.id)?.status).toBe("paused");
    const res = await h.post(`/tasks/${task.id}/resume`, { confirmDomain: null });
    expect(res.statusCode).toBe(200);
    await h.t.idle();
    expect(getTask(h.t.db, task.id)?.status).toBe("done");
    expect((await h.post(`/tasks/${task.id}/resume`)).statusCode).toBe(409);
    expect(getRun(h.t.db, Number(runId))).toBeDefined();
  });
});
