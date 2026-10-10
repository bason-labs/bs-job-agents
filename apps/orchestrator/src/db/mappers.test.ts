// DB row → shared domain type (QA phase 1). Rows come from the real repositories, and
// every mapped value must parse with the shared Zod schema the API and the web use.
import {
  ApplicationSchema,
  ApprovalTokenSchema,
  BotRecordSchema,
  CompanySchema,
  CvVersionSchema,
  EngineStateSchema,
  EventRecordSchema,
  ExportSchema,
  JobSchema,
  MemoryChangeSchema,
  MessageSchema,
  PromptVersionSchema,
  QaReviewRecordSchema,
  RoomSchema,
  RunSchema,
  SavedAnswerSchema,
  ScheduleSchema,
  SearchProfileSchema,
  StepSchema,
  SubmissionRecordSchema,
  TaskSchema,
  UploadSchema,
  isApplyBlockedByInjection,
  type MessageCard,
} from "@bs-job-agents/shared";
import { qaPassFixture, researchCompanyFixture } from "@bs-job-agents/shared/fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { openTestDb, type Db } from "./client.js";
import * as m from "./mappers.js";
import { createApproval, getApproval } from "./repos/approvals.js";
import { createApplication, getSubmissionRecord, importApplication, recordSubmission } from "./repos/applications.js";
import { getBot, getPromptVersion, appendMemoryChange, recordPromptVersion, listMemoryChanges } from "./repos/bots.js";
import { getCompany, saveCompanyProfile } from "./repos/companies.js";
import { createQaReview } from "./repos/cv.js";
import { getEngineState, pauseEngine } from "./repos/engine-state.js";
import { appendEvent, listEvents } from "./repos/events.js";
import { createUpload, recordExport, listUploadsForMessage } from "./repos/files.js";
import { flagJobInjection, getJob, setJobFit, upsertJobCandidate } from "./repos/jobs.js";
import { appendMessage, createRoom, getOrCreateConsultRoom, getOrCreateLeadRoom, listRoomMembers } from "./repos/rooms.js";
import { createStep, updateStepStatus } from "./repos/runs.js";
import { saveAnswer } from "./repos/saved-answers.js";
import { createSchedule } from "./repos/schedules.js";
import { createSearchProfile } from "./repos/search-profiles.js";
import { claimNextTask, createTask, pauseTask } from "./repos/tasks.js";
import { NOVAPAY, T0, at, seedBots, seedCv, seedJob, seedRun, seedTask } from "./test-helpers.js";

let db: Db;
beforeEach(() => {
  db = openTestDb();
  seedBots(db);
});

const SHA = "b".repeat(64);

/** Parse and return the data, failing with the Zod issues when invalid. */
function parsed<T>(schema: { safeParse(v: unknown): { success: boolean; data?: T; error?: { issues: unknown } } }, value: unknown): T {
  const r = schema.safeParse(value);
  expect(r.success, JSON.stringify(r.error?.issues, null, 2)).toBe(true);
  return r.data as T;
}

describe("jobs and companies", () => {
  it("a scanned job maps to the shared Job (ids as strings, company name joined)", () => {
    const job = seedJob(db);
    setJobFit(db, job.id, { score: 87, reasons: ["React"], gaps: ["GraphQL"] });
    const row = getJob(db, job.id)!;
    const company = getCompany(db, row.companyId)!;
    const shared = parsed(JobSchema, m.toJob(row, company));
    expect(shared).toMatchObject({
      id: String(job.id),
      companyId: String(company.id),
      company: "NovaPay",
      source: "itviec",
      language: "en",
      workMode: "hybrid",
      fitScore: 87,
      injectionFlagged: false,
      injectionClearedAt: null,
    });
  });

  it("an uploaded JD with no posting maps with url null; a flagged job blocks Apply", () => {
    const { job } = upsertJobCandidate(db, { ...NOVAPAY, source: "file", url: null, location: undefined, jdText: undefined });
    flagJobInjection(db, job.id);
    const row = getJob(db, job.id)!;
    const shared = parsed(JobSchema, m.toJob(row, getCompany(db, row.companyId)!));
    expect(shared).toMatchObject({ url: null, canonicalUrl: null, location: "", jdText: "", fitReasons: [], gaps: [] });
    expect(isApplyBlockedByInjection(shared)).toBe(true);
  });

  it("a company with and without a profile maps to the shared Company", () => {
    const job = seedJob(db);
    const stub = getCompany(db, job.companyId)!;
    expect(parsed(CompanySchema, m.toCompany(stub))).toMatchObject({ profile: null, confidence: null, researchedAt: null });
    const researched = saveCompanyProfile(db, stub.id, { profile: researchCompanyFixture.company }, { now: T0 });
    expect(parsed(CompanySchema, m.toCompany(researched))).toMatchObject({ confidence: "normal", researchedAt: T0.toISOString() });
  });
});

describe("CV versions and QA reviews", () => {
  it("a CV version and its QA review map to the shared records", () => {
    const cv = seedCv(db, seedJob(db));
    expect(parsed(CvVersionSchema, m.toCvVersion(cv))).toMatchObject({
      id: String(cv.id),
      language: "en",
      figmaFrameName: "NOVAPAY_SENIOR-FE_EN_v1",
      pdfSha256: "a".repeat(64),
    });
    const { total, scores, hardFails, fixes, injectionSuspected } = qaPassFixture;
    const review = createQaReview(db, { cvVersionId: cv.id, total, scores, hardFails, fixes, injectionSuspected });
    expect(parsed(QaReviewRecordSchema, m.toQaReview(review))).toMatchObject({ cvVersionId: String(cv.id), passed: true });
  });
});

describe("approvals, applications and the submission record (§9.1)", () => {
  function submitted(opts: { dryRun?: boolean } = {}) {
    const job = seedJob(db);
    const cv = seedCv(db, job);
    const approval = createApproval(db, { jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"] }, { now: T0 });
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id }, { now: at(1) });
    recordSubmission(
      db,
      {
        applicationId: app.id,
        dryRun: opts.dryRun,
        submission: {
          finalUrl: "https://itviec.com/applied/1234",
          fields: [
            { label: "Full name", name: "name", value: "Ba Huynh", source: "master_cv" },
            { label: "Expected salary · optional", name: "salary", value: null, source: "skipped" },
          ],
          introText: "Hi NovaPay team",
          consentTicked: true,
          consentText: "I agree to the processing of my personal data",
          uploadedFilename: "BA_HUYNH_NOVAPAY_EN.pdf",
          uploadedSha256: SHA,
          uploadedPath: `data/applications/${app.id}/BA_HUYNH_NOVAPAY_EN.pdf`,
          preSubmitScreenshotPath: `data/applications/${app.id}/pre-submit.png`,
          confirmationScreenshotPath: opts.dryRun ? null : `data/applications/${app.id}/confirmation.png`,
          confirmationText: opts.dryRun ? null : "Application sent",
          approvalToken: approval.token,
        },
        snapshot: {
          url: "https://itviec.com/it-jobs/senior-frontend-engineer-react-nextjs-novapay-1234",
          title: "Senior Frontend Engineer (React/Next.js)",
          company: "NovaPay",
          salaryText: "2,000–2,800 USD",
          jdText: "We are looking for…",
          pageScreenshotPath: `data/applications/${app.id}/jd.png`,
        },
      },
      { now: at(30) },
    );
    return { job, cv, approval, app };
  }

  it("an approval token maps to the shared ApprovalToken", () => {
    const { approval } = submitted();
    expect(parsed(ApprovalTokenSchema, m.toApprovalToken(getApproval(db, approval.token)!))).toMatchObject({
      allowedDomains: ["itviec.com"],
      createdAt: T0.toISOString(),
    });
  });

  it("an app application and its full record map to the shared Application and SubmissionRecord", () => {
    const { app, approval, cv } = submitted();
    const rec = getSubmissionRecord(db, app.id)!;
    expect(parsed(ApplicationSchema, m.toApplication(rec.application))).toMatchObject({
      status: "submitted",
      statusHistory: [
        { status: "approved", note: null },
        { status: "submitted", note: null },
      ],
    });
    const shared = parsed(SubmissionRecordSchema, m.toSubmissionRecord(rec));
    expect(shared).toMatchObject({
      applicationId: String(app.id),
      consent: { ticked: true, text: "I agree to the processing of my personal data" },
      uploadedFile: { filename: "BA_HUYNH_NOVAPAY_EN.pdf", sha256: SHA },
      approvalToken: approval.token,
      approval: { approvedAt: T0.toISOString(), cvVersionId: String(cv.id), allowedDomains: ["itviec.com"] },
      jdSnapshot: { applicationId: String(app.id), company: "NovaPay" },
      dryRun: false,
    });
  });

  it("a dry-run record maps with dryRun true and a needs_check application", () => {
    const { app } = submitted({ dryRun: true });
    const rec = getSubmissionRecord(db, app.id)!;
    expect(parsed(ApplicationSchema, m.toApplication(rec.application)).status).toBe("needs_check");
    expect(parsed(SubmissionRecordSchema, m.toSubmissionRecord(rec))).toMatchObject({ dryRun: true, confirmationText: null });
  });

  it("an imported application with a partial record maps ('not captured' parts are null)", () => {
    const dekon = seedJob(db, { ...NOVAPAY, source: "topcv", url: "https://www.topcv.vn/viec-lam/x/2316742.html", company: "DEKON", language: "vi" });
    const { application } = importApplication(db, {
      jobId: dekon.id,
      submittedAt: "2026-10-10T08:40:00.000Z",
      submission: { fields: [], uploadedFilename: "BA_HUYNH_DEKON_Figma_EN.pdf", confirmationText: "Ứng tuyển việc làm thành công!" },
      snapshot: { url: "https://www.topcv.vn/viec-lam/x/2316742.html" },
    });
    const rec = getSubmissionRecord(db, application.id)!;
    expect(parsed(ApplicationSchema, m.toApplication(application))).toMatchObject({ origin: "imported", cvVersionId: null });
    expect(parsed(SubmissionRecordSchema, m.toSubmissionRecord(rec))).toMatchObject({
      consent: null,
      uploadedFile: { filename: "BA_HUYNH_DEKON_Figma_EN.pdf", sha256: null, path: null },
      approval: null,
      // The snapshot lacks title/company/text, so it shows as not captured.
      jdSnapshot: null,
    });
    // No submission row at all → no record.
    const bare = importApplication(db, { jobId: seedJob(db, { ...NOVAPAY, url: "https://itviec.com/j/2", title: "QA", language: "en" }).id });
    expect(m.toSubmissionRecord(getSubmissionRecord(db, bare.application.id)!)).toBeNull();
  });
});

describe("runs, steps and tasks", () => {
  it("a run, its steps and its tasks map to the shared Run, Step and Task", () => {
    const ctx = seedRun(db);
    const branch = createStep(db, { runId: ctx.run.id, stepKey: "tailor", branchKey: "7", round: 2 });
    updateStepStatus(db, branch.id, "running", { now: at(1) });
    expect(parsed(RunSchema, m.toRun(ctx.run))).toMatchObject({ id: String(ctx.run.id), searchProfileVersion: null, scheduleId: null });
    expect(parsed(StepSchema, m.toStep(ctx.step))).toMatchObject({ branchKey: null, round: null });
    expect(parsed(StepSchema, m.toStep({ ...branch, status: "running" }))).toMatchObject({ branchKey: "7", round: 2 });

    const task = seedTask(db, ctx);
    claimNextTask(db, { now: at(2) });
    const paused = pauseTask(db, task.id, { code: "needs_login", site: "topcv.vn", detail: null });
    expect(parsed(TaskSchema, m.toTask(paused))).toMatchObject({
      id: String(task.id),
      runId: String(ctx.run.id),
      status: "paused",
      pauseReason: { code: "needs_login", site: "topcv.vn", detail: null },
    });
    const consult = createTask(db, { runId: null, stepId: null, botName: "qa", kind: "consult", engine: "codex", promptVersion: 1, input: {} });
    expect(parsed(TaskSchema, m.toTask(consult))).toMatchObject({ runId: null, stepId: null });
  });
});

describe("criteria, schedules, engines", () => {
  it("a search profile, a schedule and an engine state map to the shared types", () => {
    const profile = createSearchProfile(db, { roles: ["Frontend Engineer"], locations: ["Ho Chi Minh City"], minSalary: 25_000_000, currency: "VND" });
    expect(parsed(SearchProfileSchema, m.toSearchProfile(profile))).toMatchObject({
      sources: ["topcv", "itviec", "linkedin"],
      languages: ["en"],
      minSalary: 25_000_000,
    });
    const schedule = createSchedule(db, { name: "Weekdays", cron: "0 9 * * 1-5", workflowName: "job-scan", searchProfileId: profile.id });
    expect(parsed(ScheduleSchema, m.toSchedule(schedule))).toMatchObject({
      searchProfileId: String(profile.id),
      timezone: "Asia/Ho_Chi_Minh",
    });
    pauseEngine(db, "claude", { until: at(3600), reason: "usage_limit" });
    expect(parsed(EngineStateSchema, m.toEngineState(getEngineState(db, "claude")))).toMatchObject({ reason: "usage_limit" });
    expect(parsed(EngineStateSchema, m.toEngineState(getEngineState(db, "codex")))).toMatchObject({ pausedUntil: null });
  });
});

describe("chat, files, bots, events", () => {
  it("rooms and messages map to the shared Room and Message (mode from the room kind)", () => {
    const lead = getOrCreateLeadRoom(db);
    const consult = getOrCreateConsultRoom(db, "qa");
    const group = createRoom(db, { name: "cv-brainstorm", kind: "group", members: ["cv", "qa"] });
    expect(parsed(RoomSchema, m.toRoom(lead, listRoomMembers(db, lead.id)))).toMatchObject({ kind: "lead", botName: "lead" });
    expect(parsed(RoomSchema, m.toRoom(consult, listRoomMembers(db, consult.id)))).toMatchObject({ kind: "direct", members: ["qa"] });
    expect(parsed(RoomSchema, m.toRoom(group, listRoomMembers(db, group.id)))).toMatchObject({ kind: "group", botName: null });

    const upload = createUpload(db, { filename: "jd.pdf", mime: "application/pdf", size: 2048, path: "data/uploads/1-jd.pdf", sha256: SHA });
    const card: MessageCard = { type: "review_link", count: 2 };
    const fromBa = appendMessage(db, { roomId: lead.id, author: "ba", text: "Apply to this", uploadIds: [upload.id] });
    const fromLead = appendMessage(db, { roomId: lead.id, author: "lead", text: "Started", runRefs: [12], meta: { cards: [card] } });
    const system = appendMessage(db, { roomId: group.id, author: "system", text: "Room created", mentions: ["cv"] });
    const uploadsOf = (id: number) => listUploadsForMessage(db, id).map((u) => u.id);
    expect(parsed(MessageSchema, m.toMessage(fromBa, lead.kind, uploadsOf(fromBa.id)))).toMatchObject({
      author: { type: "ba" },
      mode: "work",
      uploadIds: [String(upload.id)],
    });
    expect(parsed(MessageSchema, m.toMessage(fromLead, lead.kind, []))).toMatchObject({
      author: { type: "bot", bot: "lead" },
      runIds: ["12"],
      cards: [card],
    });
    expect(parsed(MessageSchema, m.toMessage(system, group.kind, []))).toMatchObject({ author: { type: "system" }, mode: "discussion" });
    const consultMsg = appendMessage(db, { roomId: consult.id, author: "qa", text: "Because…" });
    expect(parsed(MessageSchema, m.toMessage(consultMsg, consult.kind, [])).mode).toBe("consult");
    expect(parsed(UploadSchema, m.toUpload(listUploadsForMessage(db, fromBa.id)[0]!))).toMatchObject({ messageId: String(fromBa.id) });
  });

  it("exports, saved answers, bots, prompt versions, memory changes and events map", () => {
    expect(parsed(ExportSchema, m.toExport(recordExport(db, { path: "data/exports/all.zip", applicationCount: 3 })))).toMatchObject({
      applicationCount: 3,
    });
    expect(parsed(SavedAnswerSchema, m.toSavedAnswer(saveAnswer(db, { label: "Notice period?", answer: "30 days" })))).toMatchObject({
      key: "notice period",
    });
    expect(parsed(BotRecordSchema, m.toBotRecord(getBot(db, "apply")!))).toMatchObject({ trustLevel: 1, model: null });
    recordPromptVersion(db, { botName: "cv", version: 1, roleMdHash: "h1", roleMdText: "# CV" });
    expect(parsed(PromptVersionSchema, m.toPromptVersion(getPromptVersion(db, "cv", 1)!))).toMatchObject({ version: 1 });
    const ctx = seedRun(db);
    appendMemoryChange(db, { botName: "research", note: "TopCV upload limit is 5MB", runId: ctx.run.id });
    expect(parsed(MemoryChangeSchema, m.toMemoryChange(listMemoryChanges(db, "research")[0]!))).toMatchObject({
      runId: String(ctx.run.id),
      taskId: null,
    });
    appendEvent(db, { type: "run.started", payload: { runId: String(ctx.run.id) }, runId: ctx.run.id });
    expect(parsed(EventRecordSchema, m.toEventRecord(listEvents(db)[0]!))).toMatchObject({ type: "run.started" });
  });
});
