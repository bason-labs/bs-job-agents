// Lead's tool layer (§3 rules 1 and 5): Lead only divides work, and only from the Lead chat.
import { researchScanFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { approveApplication, getCompany, getRun, getTask, upsertJobCandidate } from "../db/index.js";
import { seedCv } from "../db/test-helpers.js";
import { fake } from "./testing/fake-runner.js";
import { createTestEngine } from "./testing/harness.js";

const lead = { botName: "lead", mode: "work" as const };

describe("Lead's tools (rule 5)", () => {
  it("create_task runs a standalone Research task under the same caps; get_result returns its output", async () => {
    const t = await createTestEngine();
    const { taskId } = t.engine.lead.createTask(lead, { bot: "research", kind: "company", input: { name: "NovaPay", website: "https://novapay.example.com" } });
    expect(getTask(t.db, taskId)).toMatchObject({ runId: null, stepId: null, botName: "research", kind: "company" });
    await t.idle();
    expect(t.engine.lead.getResult(lead, { taskId })).toMatchObject({ status: "done", output: { company: expect.objectContaining({ name: "NovaPay" }) } });
    // The profile is cached for the next scan (UC-05 a).
    expect(getCompany(t.db, 1)?.profile).toMatchObject({ name: "NovaPay" });
  });

  it("refuses an outward-facing task: Lead only divides work (safety.denied trust_level)", async () => {
    const t = await createTestEngine();
    expect(() => t.engine.lead.createTask(lead, { bot: "apply", kind: "submit", input: {} })).toThrow(/outward-facing/);
    expect(t.events("safety.denied")).toEqual([expect.objectContaining({ botName: "lead", action: "create_task apply.submit", reason: "trust_level" })]);
    expect(t.tasks()).toEqual([]);
  });

  it("refuses work outside Research tasks, unknown kinds and invalid inputs", async () => {
    const t = await createTestEngine();
    expect(() => t.engine.lead.createTask(lead, { bot: "cv", kind: "tailor", input: {} })).toThrow(/runs in a workflow/);
    expect(() => t.engine.lead.createTask(lead, { bot: "lead", kind: "chat", input: {} })).toThrow(/itself/);
    expect(() => t.engine.lead.createTask(lead, { bot: "research", kind: "company", input: { name: "" } })).toThrow(/input is invalid/);
    expect(() => t.engine.lead.createTask(lead, { bot: "research" })).toThrow(/needs \{ bot, kind, input \}/);
  });

  it("a consult-mode or room bot cannot create tasks or start workflows (UC-15, UC-25)", async () => {
    const t = await createTestEngine();
    expect(() => t.engine.lead.createTask({ botName: "qa", mode: "consult" }, { bot: "research", kind: "company", input: { name: "X", website: null } })).toThrow(
      /only Lead/,
    );
    expect(() => t.engine.lead.startWorkflow({ botName: "lead", mode: "discussion" }, { workflow: "job-scan", params: {} })).toThrow(/only Lead/);
    expect(t.events("safety.denied").map((e) => [e.botName, e.reason])).toEqual([
      ["qa", "consult_mode"],
      ["lead", "consult_mode"],
    ]);
  });

  it("start_workflow starts a scan; a link already applied to is reported, not started (UC-14 a)", async () => {
    const t = await createTestEngine();
    const started = t.engine.lead.startWorkflow(lead, { workflow: "job-scan", params: {} });
    expect(started).toEqual({ started: true, runId: expect.any(Number) });
    expect(getRun(t.db, (started as { runId: number }).runId)).toMatchObject({ trigger: "chat", workflowName: "job-scan" });

    const job = upsertJobCandidate(t.db, { ...researchScanFixture.jobs[0]!, url: "https://itviec.com/it-jobs/backend-77", title: "Backend Engineer" }).job;
    const cv = seedCv(t.db, job);
    const { application } = approveApplication(t.db, { jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"] });
    expect(t.engine.lead.startWorkflow(lead, { workflow: "apply-to-link", params: { url: "https://itviec.com/it-jobs/backend-77?utm_source=x" } })).toEqual({
      started: false,
      reason: "already_applied",
      applicationId: application.id,
    });
    expect(t.engine.lead.startWorkflow(lead, { workflow: "apply-to-link", params: { url: "https://itviec.com/it-jobs/backend-77", applyAgain: true } })).toMatchObject({ started: true });
    expect(() => t.engine.lead.startWorkflow(lead, { workflow: "job-scan", params: { bogus: 1 } })).toThrow(/invalid/);
  });

  it("get_status lists active runs with steps and tasks (never a token), engines and paused tasks", async () => {
    const t = await createTestEngine();
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    const status = t.engine.lead.getStatus(lead);
    expect(status.runs).toHaveLength(1);
    expect(status.runs[0]!.run).toMatchObject({ workflowName: "job-scan", status: "waiting" });
    expect(status.runs[0]!.steps.map((s) => s.stepKey)).toContain("review");
    expect(status.engines.map((e) => e.engine)).toEqual(["claude", "codex"]);
    expect(() => t.engine.lead.getStatus(lead, { runId: 999 })).toThrow(/not found/);
  });

  it("Lead has no tool that answers or resumes Apply: only Ba's own answer reaches a waiting Apply (UC-12)", async () => {
    const t = await createTestEngine();
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    t.runner.script({
      bot: "apply",
      kind: "submit",
      times: 1,
      result: fake.applyPaused({ questions: [{ field: "notice", label: "Notice period", required: true, kind: "text", options: null }] }),
    });
    const { taskId } = t.engine.approve(1, { cvVersionId: t.review(run.id, 1)!.cvVersions[0]!.cvVersionId, introText: null });
    await t.idle();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(t.engine.lead))).toEqual(
      expect.not.arrayContaining(["answerQuestion", "resumeTask"]),
    );
    expect(getTask(t.db, taskId!)?.status).toBe("paused");
    // Ba's answer through the question card (the API) resumes it.
    expect(t.engine.answerQuestion(taskId!, { field: "notice", mode: "answer", value: "1 month", remember: false })).toEqual({ resumed: true, next: null });
    await t.idle();
    expect(getTask(t.db, taskId!)?.status).toBe("done");
  });

  it("the master CV must exist before any work starts (UC-01 c)", async () => {
    const t = await createTestEngine();
    t.masterCv.current = null;
    expect(() => t.engine.lead.startWorkflow(lead, { workflow: "job-scan", params: {} })).toThrow(/master CV is missing/);
  });
});
