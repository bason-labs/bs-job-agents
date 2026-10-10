// The apply path (UC-08 → UC-11 → §9.1) and §1.2 success 3: nothing is ever submitted without
// Ba's approval. Real SQLite, FakeRunner, fake files and bridges.
import { NEGOTIABLE_TEXT, type PendingQuestion } from "@bs-job-agents/shared";
import { applyOutputFixture, botDefinitionFixtures, qaPassFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import {
  createApplication,
  createTask,
  getApplication,
  getJob,
  getRun,
  getSavedAnswer,
  getSubmissionRecord,
  getTask,
  latestApprovalForApplication,
  listEvents,
  listMessages,
  listRooms,
  listTasks,
  mappers,
  type Db,
} from "../db/index.js";
import { fake } from "./testing/fake-runner.js";
import { createTestEngine, type TestEngine, type TestEngineOptions } from "./testing/harness.js";

const HOUR = 3600_000;

/** Run job-scan to the review card of job 1 and return what approve needs. */
async function toReview(opts: TestEngineOptions = {}) {
  const t = await createTestEngine({ sources: ["itviec"], ...opts });
  const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
  await t.idle();
  const card = t.review(run.id, 1)!;
  return { t, run, cvVersionId: card.cvVersions[0]!.cvVersionId };
}

async function approved(opts: TestEngineOptions & { dryRun?: boolean } = {}) {
  const r = await toReview(opts);
  const result = r.t.engine.approve(1, { cvVersionId: r.cvVersionId, introText: null, dryRun: opts.dryRun });
  return { ...r, applicationId: result.applicationId!, taskId: result.taskId! };
}

function safety(t: TestEngine) {
  return t.events("safety.denied");
}

function forgeApplyTask(db: Db, input: Record<string, unknown>) {
  return createTask(db, { runId: null, stepId: null, botName: "apply", kind: "submit", engine: "claude", input, promptVersion: 1, usesBrowser: true });
}

describe("nothing is submitted without Ba's approval (§1.2 success 3, §10.2 rule 1)", () => {
  it("an apply.submit task with no approval token never spawns", async () => {
    const { t, cvVersionId } = await toReview();
    const app = createApplication(t.db, { jobId: 1, cvVersionId });
    const task = forgeApplyTask(t.db, { applicationId: String(app.id), jobId: "1", cvVersionId: String(cvVersionId) });
    t.engine.dispatch();
    await t.idle();
    expect(t.runner.callsFor("apply.submit")).toEqual([]);
    expect(getTask(t.db, task.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/^denied: no approval token/) });
    expect(safety(t)).toEqual([expect.objectContaining({ taskId: String(task.id), action: "apply.submit", reason: "no_token" })]);
    expect(getApplication(t.db, app.id)?.status).toBe("approved");
  });

  it("still needs the token when Apply sits at L2 in the database (PM S1)", async () => {
    const { t, cvVersionId } = await toReview();
    // updateBot refuses L2 for Apply; force it as a corrupted or hand-edited row would.
    t.db.$client.prepare("UPDATE bots SET trust_level = 2 WHERE name = 'apply'").run();
    const app = createApplication(t.db, { jobId: 1, cvVersionId });
    forgeApplyTask(t.db, { applicationId: String(app.id), jobId: "1", cvVersionId: String(cvVersionId) });
    t.engine.dispatch();
    await t.idle();
    expect(t.runner.callsFor("apply.submit")).toEqual([]);
    expect(safety(t)).toEqual([expect.objectContaining({ reason: "no_token" })]);
  });

  it("never runs when bot.json says Apply is L2 (S6 safety rule), even with a valid approval", async () => {
    const bots = botDefinitionFixtures.map((d) => (d.name === "apply" ? { ...d, trustLevel: 2 as const } : d));
    const { t, taskId } = await approved({ bots });
    await t.idle();
    expect(t.runner.callsFor("apply.submit")).toEqual([]);
    expect(getTask(t.db, taskId)?.status).toBe("failed");
    expect(safety(t)).toEqual([expect.objectContaining({ reason: "trust_level" })]);
  });

  it("a task naming another job than its application's token is refused", async () => {
    const { t, cvVersionId } = await toReview();
    t.browser.set("claude", false); // the real Apply waits as needs_browser and never consumes the token
    const { applicationId } = t.engine.approve(1, { cvVersionId, introText: null });
    await t.idle();
    const wrongJob = forgeApplyTask(t.db, { applicationId: String(applicationId), jobId: "999", cvVersionId: String(cvVersionId) });
    t.browser.set("claude", true);
    t.engine.dispatch();
    await t.idle();
    expect(getTask(t.db, wrongJob.id)?.error).toMatch(/denied: .*another job/);
    expect(safety(t).map((e) => e.reason)).toEqual(["wrong_job"]);
    expect(latestApprovalForApplication(t.db, applicationId!)?.usedAt).toBeNull();
  });
});

describe("the approval token never reaches a prompt, a task row, an event or the UI (PM S5)", () => {
  it("only the prompt part goes to the runner and the database", async () => {
    const { t, applicationId } = await approved();
    await t.idle();
    const token = latestApprovalForApplication(t.db, applicationId)!.token;
    const call = t.runner.callsFor("apply.submit")[0]!;
    expect(call.input).not.toHaveProperty("approvalToken");
    expect(JSON.stringify(t.runner.calls.map((c) => c.input))).not.toContain(token);
    expect(JSON.stringify(listTasks(t.db).map((x) => x.input))).not.toContain(token);
    expect(JSON.stringify(listTasks(t.db).map(mappers.toTask))).not.toContain(token);
    expect(JSON.stringify(listEvents(t.db).map((e) => e.payload))).not.toContain(token);
    // The record cites the token Apply used (it is evidence, not a capability any more).
    expect(getSubmissionRecord(t.db, applicationId)?.submission?.approvalToken).toBe(token);
  });
});

describe("SHA-256 check before Apply (PM decision 2b, coordinator D)", () => {
  it("a copy that is not the approved PDF aborts before spawning: needs_check + safety.denied", async () => {
    const { t, applicationId, taskId } = await approved({ start: true });
    t.files.tamper = () => Buffer.from("%PDF-1.7 someone else's CV");
    await t.idle();
    expect(t.runner.callsFor("apply.submit")).toEqual([]);
    expect(getApplication(t.db, applicationId)?.status).toBe("needs_check");
    expect(getTask(t.db, taskId)?.error).toMatch(/^refused: the approved PDF failed its check/);
    expect(safety(t)).toEqual([expect.objectContaining({ action: "apply.record", reason: "sha_mismatch" })]);
    // Nothing ran, so the token was never used; the copy was removed.
    expect(latestApprovalForApplication(t.db, applicationId)?.usedAt).toBeNull();
    expect(t.files.files.has(`/data/applications/${applicationId}/BA_HUYNH_NOVAPAY_EN.pdf`)).toBe(false);
    expect(t.action(1, 1)).toMatchObject({ outcome: "refused" });
    expect(t.step(1, "apply", "1")?.status).toBe("failed");
  });
});

describe("apply.submit is never retried or restarted automatically (PM FYI c, UC-11 c)", () => {
  it.each([
    ["timeout", fake.timeout()],
    ["invalid output", fake.invalidOutput()],
    ["a crash", fake.failed("claude exited with 1")],
    ["a failed self-check", fake.selfCheckFailed(applyOutputFixture, ["All required fields are filled"])],
    ["a usage limit", fake.usageLimit("claude", "2026-10-10T14:00:00.000Z")],
  ])("after %s: one spawn, needs_check, no record", async (_name, result) => {
    const { t, applicationId, taskId } = await approved();
    t.runner.script({ bot: "apply", kind: "submit", result });
    await t.idle();
    expect(t.runner.callsFor("apply.submit")).toHaveLength(1);
    expect(getTask(t.db, taskId)).toMatchObject({ status: "failed", attempt: 1 });
    expect(getApplication(t.db, applicationId)?.status).toBe("needs_check");
    expect(getSubmissionRecord(t.db, applicationId)?.submission).toBeUndefined();
    expect(t.action(1, 1)).toMatchObject({ outcome: "needs_check" });
    expect(t.step(1, "record", "1")?.status).toBe("skipped");
  });

  it("no confirmation detected → needs_check with the record of what was filled (UC-11 c)", async () => {
    const { t, applicationId } = await approved();
    t.runner.script({ bot: "apply", kind: "submit", result: (task) => fake.ok({ ...applyOutputFixture, status: "needs_check", confirmationText: null, confirmationScreenshot: null, uploadedFile: { filename: "x.pdf", sha256: (task.input as { pdfSha256: string }).pdfSha256 } }) });
    await t.idle();
    expect(getApplication(t.db, applicationId)?.status).toBe("needs_check");
    expect(getSubmissionRecord(t.db, applicationId)?.submission).toMatchObject({ confirmationText: null });
  });

  it("the page shows another company or job: abort, safety event, needs_check (UC-11 d)", async () => {
    const { t, applicationId } = await approved();
    t.runner.script({ bot: "apply", kind: "submit", result: fake.selfCheckFailed(applyOutputFixture, ["The company and job title on the page match the approved job"]) });
    await t.idle();
    expect(safety(t)).toEqual([expect.objectContaining({ reason: "page_mismatch" })]);
    expect(getApplication(t.db, applicationId)?.status).toBe("needs_check");
  });
});

describe("Apply's own pauses wait for Ba (UC-11 a/b/e, UC-12, UC-17)", () => {
  const notice: PendingQuestion = { field: "notice", label: "Notice period", required: true, kind: "text", options: null };
  const salaryOpt: PendingQuestion = { field: "salary", label: "Mức lương mong muốn (VND)", required: false, kind: "salary", options: null };
  const portfolio: PendingQuestion = { field: "portfolio", label: "Portfolio URL", required: false, kind: "text", options: null };

  it("UC-12: the salary rule and optional fields answer themselves; Lead asks the rest; Ba's answer resumes", async () => {
    const { t, applicationId, taskId } = await approved();
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ questions: [salaryOpt, notice, portfolio] }) });
    await t.idle();
    const firstUse = latestApprovalForApplication(t.db, applicationId)!.usedAt;
    expect(getTask(t.db, taskId)).toMatchObject({ status: "paused", pauseReason: "needs_answer" });
    expect(getApplication(t.db, applicationId)?.status).toBe("paused");
    // Leave blank when optional (default rule): the optional salary and portfolio are skipped.
    expect(t.action(1, 1)).toMatchObject({
      answers: [
        { field: "salary", label: salaryOpt.label, value: null },
        { field: "portfolio", label: portfolio.label, value: null },
      ],
      asked: ["notice"],
    });
    // One question at a time, in the Lead chat.
    const lead = listRooms(t.db, { kind: "lead" })[0]!;
    const asked = listMessages(t.db, lead.id).filter((m) => (m.meta?.cards as { type: string }[] | undefined)?.some((c) => c.type === "question"));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.text).toMatch(/Notice period/);

    expect(() => t.engine.answerQuestion(taskId, { field: "notice", mode: "skip", value: null, remember: false })).toThrow(/required/);
    expect(t.engine.answerQuestion(taskId, { field: "notice", mode: "answer", value: "2 weeks", remember: true })).toEqual({ resumed: true, next: null });
    expect(getSavedAnswer(t.db, "Notice period")?.answer).toBe("2 weeks");
    await t.idle();

    const calls = t.runner.callsFor("apply.submit");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input).toMatchObject({ answers: expect.arrayContaining([{ field: "notice", label: "Notice period", value: "2 weeks" }]) });
    // The resume re-validated the token; it did not consume it again (PM M2).
    expect(latestApprovalForApplication(t.db, applicationId)!.usedAt).toBe(firstUse);
    expect(getApplication(t.db, applicationId)?.status).toBe("submitted");
  });

  it("UC-12, Ask me each time: optional salary is asked; Negotiable writes Thỏa thuận on a VI form", async () => {
    const { t, taskId } = await approved({ profile: { salaryPolicy: "ask" } });
    t.db.$client.prepare("UPDATE jobs SET language = 'vi' WHERE id = 1").run();
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ questions: [salaryOpt] }) });
    await t.idle();
    expect(t.action(1, 1)).toMatchObject({ asked: ["salary"], answers: [] });
    expect(t.engine.answerQuestion(taskId, { field: "salary", mode: "negotiable", value: null, remember: false }).resumed).toBe(true);
    await t.idle();
    expect(t.runner.callsFor("apply.submit")[1]!.input).toMatchObject({ answers: [{ field: "salary", value: NEGOTIABLE_TEXT.vi }] });
  });

  it("UC-17: a login wall pauses Apply; Ba clicks Done in the app; Apply resumes", async () => {
    const { t, applicationId, taskId } = await approved();
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ reason: "needs_login", site: "itviec.com" }) });
    await t.idle();
    expect(getTask(t.db, taskId)).toMatchObject({ status: "paused", pauseReason: "needs_login(itviec.com)" });
    expect(t.events("task.paused").at(-1)).toMatchObject({ reason: { code: "needs_login", site: "itviec.com" } });
    t.engine.resumeTask(taskId);
    await t.idle();
    expect(t.runner.callsFor("apply.submit")).toHaveLength(2);
    expect(getApplication(t.db, applicationId)?.status).toBe("submitted");
  });

  it("UC-11 e: the site guard stops Apply at an ATS domain; Ba confirms it; Apply respawns with it allowed", async () => {
    const { t, applicationId, taskId } = await approved();
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyDomainConfirm("novapay.breezy.hr") });
    await t.idle();
    expect(getTask(t.db, taskId)).toMatchObject({ status: "paused", pauseReason: "domain_confirm(novapay.breezy.hr)" });
    expect(safety(t)).toEqual([expect.objectContaining({ reason: "off_allowlist", action: "mcp__claude-in-chrome__navigate" })]);
    expect(() => t.engine.resumeTask(taskId, { confirmDomain: "evil.example" })).toThrow(/confirm the domain/);
    t.engine.resumeTask(taskId, { confirmDomain: "novapay.breezy.hr" });
    await t.idle();
    const second = t.runner.callsFor("apply.submit")[1]!;
    expect(second.allowedSites).toEqual(["itviec.com", "novapay.breezy.hr"]);
    expect(t.guards.siteCalls.at(-1)?.allowedSites).toEqual(["itviec.com", "novapay.breezy.hr"]);
    expect(getApplication(t.db, applicationId)?.status).toBe("submitted");
  });

  it("an expired token on resume is denied; Ba approves again and Apply starts fresh (PM M2)", async () => {
    const { t, applicationId, taskId, cvVersionId } = await approved();
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ reason: "captcha", site: "itviec.com" }) });
    await t.idle();
    t.clock.advance(25 * HOUR);
    t.engine.resumeTask(taskId);
    await t.idle();
    expect(getTask(t.db, taskId)).toMatchObject({ status: "failed", error: expect.stringMatching(/expired/) });
    expect(safety(t).at(-1)).toMatchObject({ reason: "token_expired" });
    expect(getApplication(t.db, applicationId)?.status).toBe("paused");
    // The card waits for Ba to approve again; the run stays open.
    expect(t.step(1, "apply", "1")).toMatchObject({ status: "locked", output: expect.objectContaining({ outcome: "denied" }) });
    expect(getRun(t.db, 1)?.status).toBe("waiting");

    const again = t.engine.approve(1, { cvVersionId, introText: null });
    expect(again).toMatchObject({ applicationId, reapproval: true });
    await t.idle();
    expect(t.runner.callsFor("apply.submit")).toHaveLength(2);
    expect(getApplication(t.db, applicationId)?.status).toBe("submitted");
    expect(t.review(1, 1)?.decisions.map((d) => d.decision)).toEqual(["approve", "approve"]);
  });

  it("after a denied Apply Ba may skip instead: the approved application is marked failed", async () => {
    const { t, applicationId, taskId } = await approved();
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ reason: "captcha", site: "itviec.com" }) });
    await t.idle();
    t.clock.advance(25 * HOUR);
    t.engine.resumeTask(taskId);
    await t.idle();
    t.engine.skip(1, { reason: "company_culture", note: null });
    await t.idle();
    expect(getApplication(t.db, applicationId)?.status).toBe("failed");
    expect(getJob(t.db, 1)).toMatchObject({ status: "skipped", skipReason: "company_culture" });
    expect(t.events("run.finished")[0]).toMatchObject({ status: "done" });
    expect(t.review(1, 1)?.decisions.map((d) => d.decision)).toEqual(["approve", "skip"]);
  });

  it("a second Apply for the same application is a reused token (UC-11 f)", async () => {
    const { t, applicationId, cvVersionId } = await approved();
    t.runner.script({ bot: "apply", kind: "submit", times: 1, result: fake.applyPaused({ reason: "needs_login", site: "itviec.com" }) });
    await t.idle();
    const second = forgeApplyTask(t.db, { applicationId: String(applicationId), jobId: "1", cvVersionId: String(cvVersionId) });
    t.engine.dispatch();
    await t.idle();
    expect(getTask(t.db, second.id)?.status).toBe("failed");
    expect(safety(t).at(-1)).toMatchObject({ taskId: String(second.id), reason: "token_used" });
  });
});

describe("dry runs (§12 dry-run acceptance, PM M3)", () => {
  it("fills and screenshots, never submits: a needs_check record marked dryRun", async () => {
    const { t, applicationId } = await approved({ dryRun: true });
    await t.idle();
    expect(t.runner.callsFor("apply.submit")[0]!.input).toMatchObject({ dryRun: true });
    expect(getApplication(t.db, applicationId)).toMatchObject({ status: "needs_check", dryRun: true });
    expect(getSubmissionRecord(t.db, applicationId)?.submission).toMatchObject({ dryRun: true });
    expect(getJob(t.db, 1)?.status).not.toBe("applied");
  });

  it("a dry run that reports submitted is a safety event and still needs a check", async () => {
    const { t, applicationId } = await approved({ dryRun: true });
    t.runner.script({ bot: "apply", kind: "submit", result: (task) => fake.ok({ ...applyOutputFixture, uploadedFile: { filename: "x.pdf", sha256: (task.input as { pdfSha256: string }).pdfSha256 } }) });
    await t.idle();
    expect(safety(t)).toEqual([expect.objectContaining({ reason: "dry_run_submitted" })]);
    expect(getApplication(t.db, applicationId)?.status).toBe("needs_check");
  });
});

describe("review decisions (UC-09, UC-10)", () => {
  it("request changes: Ba's comment starts a new CV round, QA again, back to review", async () => {
    const { t, run } = await toReview();
    t.engine.requestChanges(1, "Lead with Next.js; drop the education portal project");
    await t.idle();
    const tailors = t.tasks("cv.tailor");
    expect(tailors).toHaveLength(2);
    expect(tailors[1]!.input).toMatchObject({ round: 1, comment: "Lead with Next.js; drop the education portal project", fixes: [] });
    expect(t.step(run.id, "tailor", "1:en")?.output).toMatchObject({ pass: 2, outcome: "passed" });
    expect(t.step(run.id, "review", "1")?.status).toBe("waiting");
    expect(t.review(run.id, 1)?.decisions).toEqual([expect.objectContaining({ decision: "request_changes", comment: "Lead with Next.js; drop the education portal project" })]);
    expect(t.events("review.ready")).toHaveLength(2);
  });

  it("skip with a reason: the job is skipped, Apply and the record too, and the run finishes", async () => {
    const { t, run } = await toReview();
    expect(() => t.engine.skip(1, { reason: "other", note: null })).toThrow(/other/);
    t.engine.skip(1, { reason: "salary_low", note: null });
    await t.idle();
    expect(getJob(t.db, 1)).toMatchObject({ status: "skipped", skipReason: "salary_low" });
    expect(t.step(run.id, "apply", "1")?.status).toBe("skipped");
    expect(t.step(run.id, "record", "1")?.status).toBe("skipped");
    expect(t.events("run.finished")[0]).toMatchObject({ status: "done", summary: "1 job, 1 skipped" });
  });

  it("approve keeps Ba's edited intro and records the decision", async () => {
    const { t, run, cvVersionId } = await toReview();
    t.engine.approve(1, { cvVersionId, introText: "Hi NovaPay team" });
    await t.idle();
    expect(t.runner.callsFor("apply.submit")[0]!.input).toMatchObject({ introText: "Hi NovaPay team" });
    expect(t.review(run.id, 1)?.decisions).toEqual([expect.objectContaining({ decision: "approve", cvVersionId, introEdited: true })]);
    expect(() => t.engine.approve(1, { cvVersionId, introText: null })).toThrow(/not waiting/);
  });

  it("only CV versions on the card can be approved", async () => {
    const { t } = await toReview();
    expect(() => t.engine.approve(1, { cvVersionId: 999, introText: null })).toThrow(/not on this review card/);
    expect(qaPassFixture.total).toBeGreaterThanOrEqual(80);
  });
});
