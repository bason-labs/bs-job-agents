// Regression tests for the review of the apply path (W2a self-review, 2026-10-11):
// a submission is recorded as soon as Apply reports it, whatever the run's state; Apply resumes on
// its own only with new automatic answers to its questions; nothing fallible runs after the token
// is consumed; a re-run never wipes a started Apply.
import type { PendingQuestion } from "@bs-job-agents/shared";
import { applyOutputFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import {
  getApplication,
  getJob,
  getSavedAnswer,
  getSubmissionRecord,
  getTask,
  latestApprovalForApplication,
  listMessages,
  listRooms,
  saveAnswer,
} from "../db/index.js";
import { MAX_AUTO_RESUMES } from "./apply.js";
import { fake } from "./testing/fake-runner.js";
import { createTestEngine, type TestEngineOptions } from "./testing/harness.js";

const HOUR = 3600_000;

async function review(opts: TestEngineOptions = {}) {
  const t = await createTestEngine({ sources: ["itviec"], ...opts });
  const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
  await t.idle();
  return { t, run, cvVersionId: t.review(run.id, 1)!.cvVersions[0]!.cvVersionId };
}

function questionCards(t: Awaited<ReturnType<typeof createTestEngine>>) {
  const lead = listRooms(t.db, { kind: "lead" })[0];
  return lead ? listMessages(t.db, lead.id).filter((m) => (m.meta?.cards as { type: string }[] | undefined)?.some((c) => c.type === "question")) : [];
}

describe("a submission is recorded when Apply reports it, whatever the run's state (§9.1)", () => {
  it("run paused while Apply ran: the record is written at once; cancelling afterwards keeps it", async () => {
    const { t, run, cvVersionId } = await review();
    t.runner.script({ bot: "apply", kind: "submit", delayMs: 1000 });
    const { applicationId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.flush();
    t.engine.pauseRun(run.id);
    t.clock.advance(1000);
    await t.idle();
    expect(getApplication(t.db, applicationId!)?.status).toBe("submitted");
    expect(getSubmissionRecord(t.db, applicationId!)?.submission).toBeDefined();
    expect(getJob(t.db, 1)?.status).toBe("applied");
    t.engine.cancelRun(run.id);
    expect(getApplication(t.db, applicationId!)?.status).toBe("submitted");
  });

  it("a pause reported after the run was cancelled is not left hanging: needs_check, no question card", async () => {
    const { t, run, cvVersionId } = await review();
    const notice: PendingQuestion = { field: "notice", label: "Notice period", required: true, kind: "text", options: null };
    t.runner.script({
      bot: "apply",
      kind: "submit",
      result: () => {
        // Ba cancels just as the CLI exits with its pause.
        t.engine.cancelRun(run.id);
        return fake.applyPaused({ questions: [notice] });
      },
    });
    const { applicationId, taskId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(getTask(t.db, taskId!)?.status).toBe("failed");
    expect(getApplication(t.db, applicationId!)?.status).toBe("needs_check");
    expect(questionCards(t)).toEqual([]);
  });
});

describe("Apply resumes on its own only with new automatic answers (UC-12, PM FYI c)", () => {
  const salary: PendingQuestion = { field: "salary", label: "Expected salary", required: true, kind: "salary", options: null };

  it("a question Apply re-reports after an automatic answer goes to Ba instead of looping", async () => {
    const { t, cvVersionId } = await review({ profile: { salaryPolicy: "negotiable" } });
    // The salary field only takes numbers: Apply keeps asking.
    t.runner.script({ bot: "apply", kind: "submit", result: fake.applyPaused({ questions: [salary] }) });
    const { taskId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    // One automatic resume with "Negotiable", then Ba is asked.
    expect(t.runner.callsFor("apply.submit")).toHaveLength(2);
    expect(getTask(t.db, taskId!)).toMatchObject({ status: "paused", pauseReason: "needs_answer" });
    expect(questionCards(t)).toHaveLength(1);
    expect(questionCards(t)[0]!.text).toMatch(/Expected salary/);
    expect(t.action(1, 1)).toMatchObject({ answers: [], asked: ["salary"] });
  });

  it("a pause for answers that lists no question ends in needs_check instead of waiting forever", async () => {
    const { t, cvVersionId } = await review();
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ questions: [] }) });
    const { applicationId, taskId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(t.runner.callsFor("apply.submit")).toHaveLength(1);
    expect(getTask(t.db, taskId!)?.status).toBe("failed");
    expect(getApplication(t.db, applicationId!)?.status).toBe("needs_check");
    expect(questionCards(t)).toEqual([]);
  });

  it("stops resuming on its own after MAX_AUTO_RESUMES; then Ba is asked", async () => {
    const { t, cvVersionId } = await review({ profile: { salaryPolicy: "negotiable" } });
    // Each pause brings a new question that answers itself (optional → left blank).
    let n = 0;
    t.runner.script({
      bot: "apply",
      kind: "submit",
      result: () => fake.applyPaused({ questions: [{ field: `extra${++n}`, label: `Extra ${n}`, required: false, kind: "text", options: null }] }),
    });
    const { taskId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(t.runner.callsFor("apply.submit")).toHaveLength(MAX_AUTO_RESUMES + 1);
    expect(getTask(t.db, taskId!)).toMatchObject({ status: "paused", pauseReason: "needs_answer" });
    expect(questionCards(t)).toHaveLength(1);
    expect(t.action(1, 1)).toMatchObject({ autoResumes: MAX_AUTO_RESUMES, asked: [`extra${MAX_AUTO_RESUMES + 1}`] });
  });

  it("never resumes on its own after a login, a CAPTCHA or a domain to confirm", async () => {
    const { t, cvVersionId } = await review();
    // A domain to confirm, plus an optional question that would answer itself (left blank).
    const portfolio: PendingQuestion = { field: "portfolio", label: "Portfolio URL", required: false, kind: "text", options: null };
    const paused = fake.applyPaused({ reason: "domain_confirm", site: "novapay.breezy.hr" });
    if (paused.status === "ok") (paused.output as { pendingQuestions: PendingQuestion[] }).pendingQuestions = [portfolio];
    t.runner.script({
      bot: "apply",
      kind: "submit",
      result: (task) => {
        // PM2 M2: the site guard really blocked that host in this attempt.
        t.guards.logBlock(`/data/transcripts/${task.taskId}-${task.attempt}.guard.jsonl`, { guard: "site", tool: "mcp__claude-in-chrome__navigate", rule: "navigate_host", reason: "blocked", target: "novapay.breezy.hr" });
        return paused;
      },
    });
    const { taskId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(t.runner.callsFor("apply.submit")).toHaveLength(1);
    expect(getTask(t.db, taskId!)).toMatchObject({ status: "paused", pauseReason: "domain_confirm(novapay.breezy.hr)" });
  });

  it("a saved answer fills a choice only when it is one of the options", async () => {
    const { t, cvVersionId } = await review();
    saveAnswer(t.db, { label: "Level", answer: "Senior" });
    const level: PendingQuestion = { field: "level", label: "Level", required: true, kind: "choice", options: ["Junior", "Middle"] };
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ questions: [level] }) });
    t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(t.runner.callsFor("apply.submit")).toHaveLength(1);
    expect(t.action(1, 1)).toMatchObject({ asked: ["level"], answers: [] });
  });
});

describe("nothing fallible runs after the token is consumed", () => {
  it("a failure while preparing Apply leaves the token unused and the card approvable again", async () => {
    const { t, cvVersionId } = await review();
    const siteGuard = t.guards.siteGuard.bind(t.guards);
    let broken = true;
    t.guards.siteGuard = (o) => {
      if (broken) throw new Error("hook entry missing");
      return siteGuard(o);
    };
    const { applicationId, taskId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(t.runner.callsFor("apply.submit")).toEqual([]);
    expect(getTask(t.db, taskId!)?.status).toBe("failed");
    expect(latestApprovalForApplication(t.db, applicationId!)?.usedAt).toBeNull();
    expect(getApplication(t.db, applicationId!)?.status).toBe("approved");
    expect(t.step(1, "apply", "1")?.status).toBe("locked");

    broken = false;
    expect(t.engine.approve(1, { cvVersionId, introText: null })).toMatchObject({ applicationId, reapproval: true });
    await t.idle();
    expect(getApplication(t.db, applicationId!)?.status).toBe("submitted");
  });

  it("an answer key that normalises to nothing is never saved, so it cannot break every later Apply", async () => {
    const { t, cvVersionId } = await review();
    const star: PendingQuestion = { field: "x", label: "*", required: true, kind: "text", options: null };
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ questions: [star] }) });
    const { applicationId, taskId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(t.engine.answerQuestion(taskId!, { field: "x", mode: "answer", value: "yes", remember: true }).resumed).toBe(true);
    await t.idle();
    expect(getSavedAnswer(t.db, "*")).toBeUndefined();
    expect(() => saveAnswer(t.db, { label: " ? ", answer: "x" })).toThrow(/empty/);
    expect(getApplication(t.db, applicationId!)?.status).toBe("submitted");
  });

  it("a resumed Apply cancelled before its next spawn needs a check (an earlier spawn ran)", async () => {
    const { t, run, cvVersionId } = await review();
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ reason: "needs_login", site: "itviec.com" }) });
    const { applicationId, taskId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    const release = t.browser.hold();
    t.engine.resumeTask(taskId!);
    await t.flush();
    t.engine.cancelRun(run.id);
    release();
    await t.idle();
    expect(t.runner.callsFor("apply.submit")).toHaveLength(1);
    expect(getApplication(t.db, applicationId!)?.status).toBe("needs_check");
  });

  it("Apply reporting another file than the orchestrator's copy is recorded, but needs a check", async () => {
    const { t, cvVersionId } = await review();
    t.runner.script({
      bot: "apply",
      kind: "submit",
      result: (task) => fake.ok({ ...applyOutputFixture, uploadedFile: { filename: "OTHER.pdf", sha256: (task.input as { pdfSha256: string }).pdfSha256 } }),
    });
    const { applicationId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    expect(getApplication(t.db, applicationId!)?.status).toBe("needs_check");
    expect(getSubmissionRecord(t.db, applicationId!)?.submission).toMatchObject({ uploadedFilename: "BA_HUYNH_NOVAPAY_EN.pdf" });
    // The raw report stays on the task as evidence.
    expect(getTask(t.db, t.tasks("apply.submit")[0]!.id)?.output).toMatchObject({ uploadedFile: { filename: "OTHER.pdf" } });
  });
});

describe("re-run never wipes a started Apply (UC-23)", () => {
  it("after a denied resume, the branch still counts as applied", async () => {
    const { t, run, cvVersionId } = await review();
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ reason: "captcha", site: "itviec.com" }) });
    const { taskId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    t.clock.advance(25 * HOUR);
    t.engine.resumeTask(taskId!);
    await t.idle();
    expect(t.step(run.id, "apply", "1")?.status).toBe("locked");
    expect(() => t.engine.rerunStep(t.step(run.id, "company", "1")!.id)).toThrow(/Apply already started/);
  });
});
