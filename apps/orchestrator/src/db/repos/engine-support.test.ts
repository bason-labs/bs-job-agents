// Data-layer support for the Phase 2 engine: PM should-fix S1 (Apply stays at L1), S2 (crash
// recovery marks the interrupted Apply's application needs_check atomically), S3 (jobs left
// `new` by a failed or cancelled run are offered again), and small helpers the engine uses.
import { NON_RETRYABLE_TASKS } from "@bs-job-agents/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { openTestDb, type Db } from "../client.js";
import { TrustLevelRefusedError } from "../errors.js";
import { toAppEvent } from "../mappers.js";
import { NOVAPAY, T0, at, seedApprovedApplication, seedBots, seedCv, seedJob } from "../test-helpers.js";
import type { Run, Task } from "../types.js";
import { getApplication, recordSubmission } from "./applications.js";
import { createApproval, latestApprovalForApplication } from "./approvals.js";
import { getBot, updateBot, upsertBot } from "./bots.js";
import { appendAppEvent, listEvents } from "./events.js";
import { dedupeCandidates, jobIdsInActiveRuns, setJobStatus, upsertJobCandidate } from "./jobs.js";
import { DEFAULT_NON_RETRYABLE, INTERRUPTED_BEFORE_PAGE_NOTE, recoverInterruptedTasks } from "./recovery.js";
import { createRun, createStep, getRun, updateRunStatus } from "./runs.js";
import { createSearchProfile, updateSearchProfile } from "./search-profiles.js";
import { claimNextTask, createTask, getTask, pauseTask, updateTaskInput } from "./tasks.js";

let db: Db;
beforeEach(() => {
  db = openTestDb();
  seedBots(db);
});

function run(status: Run["status"] = "running"): Run {
  const r = createRun(db, { workflowName: "job-scan", workflowVersion: 1, trigger: "chat", params: {} }, { now: T0 });
  return status === "running" ? r : updateRunStatus(db, r.id, status, { now: T0 });
}

function task(runId: number, botName: string, kind: string, input: unknown, engine: "claude" | "codex" = "codex"): Task {
  return createTask(db, { runId, stepId: null, botName, kind, engine, input, promptVersion: 1 }, { now: T0 });
}

describe("bots: Apply stays at L1 in Phase 1 (UC-19, PM S1)", () => {
  it("upsertBot refuses Apply at L2 and writes nothing", () => {
    expect(() => upsertBot(db, { name: "apply", displayName: "Apply", engine: "claude", trustLevel: 2 })).toThrow(TrustLevelRefusedError);
    expect(getBot(db, "apply")?.trustLevel).toBe(1);
  });

  it("updateBot refuses promoting Apply to L2; other bots may be L2 and Apply may be demoted", () => {
    expect(() => updateBot(db, "apply", { trustLevel: 2 })).toThrow(/Apply stays at L1/);
    expect(getBot(db, "apply")?.trustLevel).toBe(1);
    expect(updateBot(db, "apply", { trustLevel: 0 }).trustLevel).toBe(0);
    expect(updateBot(db, "cv", { trustLevel: 2 }).trustLevel).toBe(2);
    expect(upsertBot(db, { name: "qa", displayName: "QA", engine: "codex", trustLevel: 2 }).trustLevel).toBe(2);
  });
});

describe("recoverInterruptedTasks marks the interrupted Apply's application needs_check (UC-18, PM S2)", () => {
  function applyTask(applicationId: number, jobId: number, cvVersionId: number): Task {
    const r = run();
    const step = createStep(db, { runId: r.id, stepKey: "apply", branchKey: String(jobId) });
    return createTask(
      db,
      {
        runId: r.id,
        stepId: step.id,
        botName: "apply",
        kind: "submit",
        engine: "claude",
        input: { applicationId: String(applicationId), jobId: String(jobId), cvVersionId: String(cvVersionId) },
        promptVersion: 1,
        usesBrowser: true,
      },
      { now: T0 },
    );
  }

  it("takes the non-retryable list from the shared constants", () => {
    expect(DEFAULT_NON_RETRYABLE).toEqual(NON_RETRYABLE_TASKS);
  });

  it("in the same transaction as the task, with an application.updated event", () => {
    const job = seedJob(db);
    const cv = seedCv(db, job);
    const { application } = seedApprovedApplication(db, job, cv);
    const t = applyTask(application.id, job.id, cv.id);
    claimNextTask(db, { now: at(1) });

    const r = recoverInterruptedTasks(db, { now: at(10) });
    expect(r.needsCheck.map((x) => x.id)).toEqual([t.id]);
    expect(r.needsCheckApplicationIds).toEqual([application.id]);
    expect(getTask(db, t.id)?.status).toBe("interrupted");
    const app = getApplication(db, application.id)!;
    expect(app.status).toBe("needs_check");
    expect(app.statusHistory.at(-1)).toMatchObject({ status: "needs_check", note: "interrupted by restart; it may already have been submitted" });
    const updated = listEvents(db, { types: ["application.updated"] }).map(toAppEvent);
    expect(updated).toEqual([expect.objectContaining({ applicationId: String(application.id), status: "needs_check" })]);
  });

  describe("live 2026-10-20: the recorded tool calls decide whether a job-site page was opened", () => {
    const CHROME = "mcp__claude-in-chrome__";
    function started(t: Task, tools: string[]) {
      const ref = { taskId: String(t.id), runId: String(t.runId), stepId: String(t.stepId), botName: "apply" };
      appendAppEvent(db, { type: "task.started", ...ref, kind: "submit", engine: "claude", attempt: 1 }, { now: at(2) });
      for (const tool of tools) appendAppEvent(db, { type: "task.progress", ...ref, kind: "tool_use", text: `${tool}: started`, tool }, { now: at(3) });
    }
    function interrupted(tools: string[]) {
      const job = seedJob(db);
      const cv = seedCv(db, job);
      const { application } = seedApprovedApplication(db, job, cv);
      const t = applyTask(application.id, job.id, cv.id);
      claimNextTask(db, { now: at(1) });
      started(t, tools);
      return { t, application, r: recoverInterruptedTasks(db, { now: at(10) }) };
    }

    it("Chrome never answered (tabs_context_mcp twice, tabs_create_mcp just started): not submitted, failed, so Apply again is offered", () => {
      const { t, application, r } = interrupted([`${CHROME}tabs_context_mcp`, "Read", `${CHROME}tabs_context_mcp`, `${CHROME}tabs_create_mcp`]);
      expect(r.needsCheck).toEqual([]);
      expect(r.needsCheckApplicationIds).toEqual([]);
      expect(r.notSubmitted.map((x) => x.id)).toEqual([t.id]);
      expect(r.notSubmittedApplicationIds).toEqual([application.id]);
      const app = getApplication(db, application.id)!;
      expect(app.status).toBe("failed");
      expect(app.statusHistory.at(-1)!.note).toBe(INTERRUPTED_BEFORE_PAGE_NOTE);
      expect(getTask(db, t.id)?.status).toBe("interrupted");
    });

    for (const tool of ["navigate", "form_input", "computer", "find", "read_page", "javascript_tool", "some_new_tool"]) {
      it(`a ${tool} call means a page may have been touched: needs_check as before`, () => {
        const { application, r } = interrupted([`${CHROME}tabs_context_mcp`, `${CHROME}${tool}`]);
        expect(r.needsCheckApplicationIds).toEqual([application.id]);
        expect(getApplication(db, application.id)!.status).toBe("needs_check");
      });
    }

    it("no record of the attempt starting: needs_check as before (nothing proves no page was opened)", () => {
      const job = seedJob(db);
      const cv = seedCv(db, job);
      const { application } = seedApprovedApplication(db, job, cv);
      applyTask(application.id, job.id, cv.id);
      claimNextTask(db, { now: at(1) });
      expect(recoverInterruptedTasks(db, { now: at(10) }).needsCheckApplicationIds).toEqual([application.id]);
    });
  });

  it("reconciles Apply tasks an older build left interrupted while the application stayed approved", () => {
    const job = seedJob(db);
    const cv = seedCv(db, job);
    const { application } = seedApprovedApplication(db, job, cv);
    const t = applyTask(application.id, job.id, cv.id);
    claimNextTask(db, { now: at(1) });
    // An older recovery: the task was marked interrupted, the application never touched.
    db.$client.prepare("UPDATE tasks SET status = 'interrupted' WHERE id = ?").run(t.id);

    const r = recoverInterruptedTasks(db, { now: at(10) });
    expect(r.needsCheck).toEqual([]);
    expect(r.needsCheckApplicationIds).toEqual([application.id]);
    expect(getApplication(db, application.id)?.status).toBe("needs_check");
    // Idempotent: the next start-up changes nothing.
    expect(recoverInterruptedTasks(db, { now: at(20) }).needsCheckApplicationIds).toEqual([]);
  });

  it("leaves an application that already left the apply flow alone", () => {
    const job = seedJob(db);
    const cv = seedCv(db, job);
    const { application, approval } = seedApprovedApplication(db, job, cv);
    const t = applyTask(application.id, job.id, cv.id);
    claimNextTask(db, { now: at(1) });
    recordSubmission(db, {
      applicationId: application.id,
      submission: { fields: [], approvalToken: approval.token, uploadedSha256: cv.pdfSha256 },
      snapshot: { url: NOVAPAY.url!, title: NOVAPAY.title, company: NOVAPAY.company, jdText: "JD" },
    });
    const r = recoverInterruptedTasks(db, { now: at(10) });
    expect(r.needsCheck.map((x) => x.id)).toEqual([t.id]);
    expect(r.needsCheckApplicationIds).toEqual([]);
    expect(getApplication(db, application.id)?.status).toBe("submitted");
  });
});

describe("dedupeCandidates offers jobs left new by a failed or cancelled run again (PM S3)", () => {
  it("a new job no active run owns is fresh again; a scored one stays a duplicate", () => {
    const { job } = upsertJobCandidate(db, NOVAPAY, { now: T0 });
    const failed = run("failed");
    task(failed.id, "research", "fit", { jobId: String(job.id) });
    expect(dedupeCandidates(db, [NOVAPAY]).fresh.map((j) => j.id)).toEqual([job.id]);

    setJobStatus(db, job.id, "below_threshold");
    expect(dedupeCandidates(db, [NOVAPAY]).fresh).toEqual([]);
  });

  it("a new job an active run is still scoring stays a duplicate", () => {
    const { job } = upsertJobCandidate(db, NOVAPAY, { now: T0 });
    const active = run();
    task(active.id, "research", "fit", { jobId: String(job.id) });
    expect(jobIdsInActiveRuns(db)).toEqual(new Set([job.id]));
    const r = dedupeCandidates(db, [NOVAPAY]);
    expect(r.fresh).toEqual([]);
    expect(r.duplicates.map((d) => d.job.id)).toEqual([job.id]);
  });

  it("a per-job branch of an active run owns its job (branch keys such as 42 or 42:vi)", () => {
    const { job } = upsertJobCandidate(db, NOVAPAY, { now: T0 });
    const active = run("waiting");
    createStep(db, { runId: active.id, stepKey: "tailor", branchKey: `${job.id}:vi` });
    expect(jobIdsInActiveRuns(db)).toEqual(new Set([job.id]));
    expect(dedupeCandidates(db, [NOVAPAY]).fresh).toEqual([]);
  });

  it("a run re-running its own dedupe (UC-23) does not count as an owner", () => {
    const { job } = upsertJobCandidate(db, NOVAPAY, { now: T0 });
    const active = run();
    task(active.id, "research", "fit", { jobId: String(job.id) });
    expect(dedupeCandidates(db, [NOVAPAY], { excludeRunId: active.id }).fresh.map((j) => j.id)).toEqual([job.id]);
    expect(jobIdsInActiveRuns(db, { excludeRunId: active.id })).toEqual(new Set());
  });

  it("a candidate twice in one batch is still offered once", () => {
    const { job } = upsertJobCandidate(db, NOVAPAY, { now: T0 });
    const r = dedupeCandidates(db, [NOVAPAY, NOVAPAY]);
    expect(r.fresh.map((j) => j.id)).toEqual([job.id]);
    expect(r.duplicates).toHaveLength(1);
  });
});

describe("engine helpers", () => {
  it("pauseTask keeps the bot's output, so a resume knows Apply paused itself", () => {
    const r = run();
    const t = task(r.id, "apply", "submit", { applicationId: "1" }, "claude");
    claimNextTask(db, { now: at(1) });
    const paused = pauseTask(db, t.id, { code: "needs_answer", site: null, detail: null }, { output: { status: "paused" } });
    expect(paused).toMatchObject({ status: "paused", pauseReason: "needs_answer", output: { status: "paused" } });
  });

  it("updateTaskInput stores the input a spawn was given (UC-22)", () => {
    const r = run();
    const t = task(r.id, "research", "company", { name: "NovaPay", website: null });
    expect(updateTaskInput(db, t.id, { name: "NovaPay", website: "https://novapay.example.com" }).input).toEqual({
      name: "NovaPay",
      website: "https://novapay.example.com",
    });
  });

  it("latestApprovalForApplication returns the newest token issued for an application", () => {
    const job = seedJob(db);
    const cv = seedCv(db, job);
    const { application, approval: first } = seedApprovedApplication(db, job, cv);
    expect(latestApprovalForApplication(db, application.id)?.token).toBe(first.token);
    // After expiry Ba approves again: a new token for the same application.
    const second = createApproval(
      db,
      { applicationId: application.id, jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"] },
      { now: at(25 * 3600) },
    );
    expect(latestApprovalForApplication(db, application.id)?.token).toBe(second.token);
    expect(latestApprovalForApplication(db, 999)).toBeUndefined();
  });

  it("a run pins the Search Profile version row it started with (UC-21b)", () => {
    const v1 = createSearchProfile(db, { roles: ["Frontend Engineer"], locations: ["Ho Chi Minh City"] }, { now: T0 });
    const r = createRun(db, {
      workflowName: "job-scan",
      workflowVersion: 1,
      trigger: "chat",
      params: {},
      searchProfileId: v1.id,
      searchProfileVersion: v1.version,
    });
    updateSearchProfile(db, { maxJobs: 3 }, { now: at(5) });
    expect(getRun(db, r.id)).toMatchObject({ searchProfileId: v1.id, searchProfileVersion: 1 });
    expect(getRun(db, run().id)?.searchProfileId).toBeNull();
  });
});
