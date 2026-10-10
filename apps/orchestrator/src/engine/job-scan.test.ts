// Integration (§12): the whole job-scan workflow on real SQLite with the FakeRunner, from the
// trigger to research fan-out, dedupe / fit / top-N, company, CV ⇄ QA gate, review card,
// approve, apply and the frozen record (§7.2, UC-01..UC-11, §1.2 success 1–2).
import { qaFailFixture, qaPassFixture, researchCompanyFixture, researchScanFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import {
  clearJobInjection,
  getApplication,
  getCompany,
  getCvVersion,
  getJob,
  getRun,
  getSubmissionRecord,
  listQaReviews,
  listSteps,
  saveCompanyProfile,
  setJobStatus,
  upsertJobCandidate,
} from "../db/index.js";
import { fake } from "./testing/fake-runner.js";
import { createTestEngine } from "./testing/harness.js";

const NOVAPAY = researchScanFixture.jobs[0]!;
const SAO_VIET = researchScanFixture.jobs[1]!;

describe("job-scan from trigger to record (§7.2)", () => {
  it("scan → dedupe → fit → top → company → CV ⇄ QA → review → approve → apply → record", async () => {
    const t = await createTestEngine({ sources: ["itviec"] });
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();

    // Review card ready; the run waits for Ba.
    expect(t.runner.calls.map((c) => `${c.bot.name}.${c.kind}`)).toEqual(["research.scan", "research.fit", "research.company", "cv.tailor", "qa.review"]);
    const job = getJob(t.db, 1)!;
    expect(job).toMatchObject({ title: NOVAPAY.title, status: "reviewing", fitScore: 87 });
    const card = t.review(run.id, job.id)!;
    expect(card).toMatchObject({ qaPassed: true, escalated: false, needsInput: false, defaultLanguage: "en" });
    expect(t.step(run.id, "apply", "1")?.status).toBe("locked");
    expect(t.events("review.ready")).toEqual([expect.objectContaining({ jobId: "1", company: "NovaPay", qaPassed: true, escalated: false })]);
    expect(getRun(t.db, run.id)?.status).toBe("waiting");

    // The CV version holds the orchestrator's export and hash (§6.2, decision 2a).
    const cv = getCvVersion(t.db, card.cvVersions[0]!.cvVersionId)!;
    expect(cv.pdfPath).toMatch(/^pdf\/NOVAPAY_.+_EN_v1\.pdf$/);
    expect(cv.pdfSha256).toBe(t.figma.exports[0]!.sha256);
    expect(listQaReviews(t.db, cv.id)).toEqual([expect.objectContaining({ total: 88, passed: true })]);

    // UC-08: approve → the application, its token and the apply task in one go.
    const approved = t.engine.approve(job.id, { cvVersionId: cv.id, introText: null });
    expect(approved).toMatchObject({ applicationId: 1, approval: { allowedDomains: ["itviec.com"] } });
    await t.idle();

    const apply = t.runner.callsFor("apply.submit");
    expect(apply).toHaveLength(1);
    expect(apply[0]!.readDirs).toEqual(["/data/applications/1"]);
    expect(apply[0]!.allowedSites).toEqual(["itviec.com"]);
    expect(apply[0]!.input).toMatchObject({ pdfPath: "/data/applications/1/BA_HUYNH_NOVAPAY_EN.pdf", pdfSha256: cv.pdfSha256 });
    expect(apply[0]!.hookSettings).toBeDefined();

    const app = getApplication(t.db, approved.applicationId!)!;
    expect(app.status).toBe("submitted");
    const record = getSubmissionRecord(t.db, app.id)!;
    expect(record.submission).toMatchObject({
      uploadedFilename: "BA_HUYNH_NOVAPAY_EN.pdf",
      uploadedPath: "applications/1/BA_HUYNH_NOVAPAY_EN.pdf",
      // §9.1: the orchestrator's hash of the uploaded copy, equal to the approved PDF's.
      uploadedSha256: cv.pdfSha256,
      consentTicked: true,
    });
    expect(record.approval?.usedAt).not.toBeNull();
    expect(record.snapshot).toMatchObject({ title: NOVAPAY.title, company: "NovaPay" });
    expect(getJob(t.db, job.id)?.status).toBe("applied");
    const finished = t.events("run.finished");
    expect(finished).toEqual([expect.objectContaining({ runId: String(run.id), status: "done", summary: "1 job, 1 submitted" })]);
    expect(listSteps(t.db, run.id).every((s) => ["done", "skipped"].includes(s.status))).toBe(true);
  });

  it("fans out over sources; a VI JD gets VI and EN CVs (§6.3) and the card defaults to VI", async () => {
    const t = await createTestEngine({ sources: ["topcv", "itviec", "linkedin"] });
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.tasks("research.scan").map((x) => (x.input as { source: string }).source)).toEqual(["topcv", "itviec", "linkedin"]);
    // LinkedIn scans are capped (UC-03 c).
    expect(t.tasks("research.scan")[2]!.input).toMatchObject({ maxPageViews: 40 });
    const saoViet = getJob(t.db, 1)!;
    expect(saoViet.title).toBe(SAO_VIET.title);
    expect(t.step(run.id, "tailor", "1:vi")?.status).toBe("done");
    expect(t.step(run.id, "tailor", "1:en")?.status).toBe("done");
    expect(t.review(run.id, saoViet.id)).toMatchObject({ defaultLanguage: "vi", cvVersions: [expect.objectContaining({ language: "vi" }), expect.objectContaining({ language: "en" })] });
    expect(t.events("review.ready")).toHaveLength(2);
  });

  it("dedupe drops jobs already known; the run ends with no strong matches when nothing passes (UC-04 a)", async () => {
    const t = await createTestEngine({ sources: ["itviec", "topcv"] });
    // NovaPay was scored in an earlier run.
    const known = upsertJobCandidate(t.db, NOVAPAY).job;
    setJobStatus(t.db, known.id, "below_threshold");
    t.runner.script({ bot: "research", kind: "fit", result: fake.ok({ fit: { score: 41, reasons: ["Frontend"], gaps: ["Needs 5 years of Vue"] }, selfCheck: [{ item: "Every reason cites master data", passed: true, note: null }], memoryNotes: [] }) });
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.step(run.id, "dedupe")?.output).toMatchObject({ items: [expect.objectContaining({ title: SAO_VIET.title })], duplicates: 1 });
    expect(t.step(run.id, "top")?.output).toMatchObject({ items: [], belowThreshold: [expect.objectContaining({ fitScore: 41, gaps: ["Needs 5 years of Vue"] })] });
    expect(getJob(t.db, 2)?.status).toBe("below_threshold");
    expect(t.events("run.finished")[0]).toMatchObject({ status: "done", summary: expect.stringMatching(/^No strong matches/) });
  });

  it("a job Ba skipped stays out of later scans unless the run says “show skipped” (UC-04 b)", async () => {
    const t = await createTestEngine({ sources: ["itviec"] });
    const first = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    t.engine.skip(1, { reason: "salary_low", note: null });
    await t.idle();
    expect(getRun(t.db, first.id)?.status).toBe("done");

    const again = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.step(again.id, "dedupe")?.output).toMatchObject({ items: [], duplicates: 1 });

    const shown = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null, showSkipped: true } }, { trigger: "chat" });
    await t.idle();
    expect(t.step(shown.id, "dedupe")?.output).toMatchObject({ items: [expect.objectContaining({ jobId: 1 })], duplicates: 0 });
    expect(t.review(shown.id, 1)).toBeDefined();
  });

  it("top-N keeps the best fits above the threshold (§7.2 step 5)", async () => {
    const t = await createTestEngine({ sources: ["topcv", "itviec"], profile: { maxJobs: 1, fitThreshold: 70 } });
    t.runner.script({
      bot: "research",
      kind: "fit",
      result: (task) => fake.ok({ fit: { score: (task.input as { job: { company: string } }).job.company === "NovaPay" ? 90 : 75, reasons: ["ok"], gaps: [] }, selfCheck: [{ item: "x", passed: true, note: null }], memoryNotes: [] }),
    });
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.step(run.id, "top")?.output).toMatchObject({ items: [expect.objectContaining({ company: "NovaPay" })], threshold: 70, take: 1 });
    expect(t.tasks("research.company")).toHaveLength(1);
  });

  it("reuses a company profile younger than 30 days (UC-05 a)", async () => {
    const t = await createTestEngine({ sources: ["itviec"] });
    const job = upsertJobCandidate(t.db, NOVAPAY).job;

    saveCompanyProfile(t.db, job.companyId, { profile: researchCompanyFixture.company }, { now: t.clock.now() });
    setJobStatus(t.db, job.id, "new");
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.tasks("research.company")).toHaveLength(0);
    expect(t.step(run.id, "company", String(job.id))).toMatchObject({ status: "skipped", output: { cacheHit: true } });
    expect(getCompany(t.db, job.companyId)?.profile?.name).toBe("NovaPay");
    expect(t.review(run.id, job.id)).toBeDefined();
  });
});

describe("the QA gate (UC-07, §7.2 step 7)", () => {
  it("fail → revise with QA's fixes → pass", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "qa", kind: "review", times: 1, result: fake.ok(qaFailFixture) });
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    const tailors = t.tasks("cv.tailor");
    expect(tailors).toHaveLength(2);
    expect(tailors[1]!.input).toMatchObject({ round: 2, fixes: qaFailFixture.fixes, previousCvVersionId: expect.any(String) });
    const gate = t.step(run.id, "tailor", "1:en")!;
    expect(gate).toMatchObject({ status: "done", round: 2 });
    expect(gate.output).toMatchObject({ outcome: "passed", rounds: [expect.objectContaining({ round: 1, passed: false }), expect.objectContaining({ round: 2, passed: true })] });
    expect(t.review(run.id, 1)).toMatchObject({ qaPassed: true, escalated: false });
  });

  it("three failed rounds escalate to Ba with every round visible (UC-07 a)", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "qa", kind: "review", result: fake.ok(qaFailFixture) });
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.tasks("cv.tailor")).toHaveLength(3);
    expect(t.tasks("qa.review")).toHaveLength(3);
    expect(t.step(run.id, "tailor", "1:en")?.output).toMatchObject({ outcome: "escalated", rounds: [{ round: 1 }, { round: 2 }, { round: 3 }].map((r) => expect.objectContaining(r)) });
    expect(t.review(run.id, 1)).toMatchObject({ qaPassed: false, escalated: true });
    expect(t.events("review.ready")[0]).toMatchObject({ qaPassed: false, escalated: true });
  });

  it("injection suspected flags the job; Apply stays disabled until Ba confirms (UC-07 b)", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "qa", kind: "review", result: fake.ok({ ...qaFailFixture, total: 88, scores: qaPassFixture.scores, hardFails: [], injectionSuspected: true, injectionNote: "the JD says 'ignore previous instructions'" }) });
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.events("review.ready")[0]).toMatchObject({ injectionFlagged: true });
    const card = t.review(run.id, 1)!;
    expect(() => t.engine.approve(1, { cvVersionId: card.cvVersions[0]!.cvVersionId, introText: null })).toThrow(/suspected injection/);
    clearJobInjection(t.db, 1);
    expect(t.engine.approve(1, { cvVersionId: card.cvVersions[0]!.cvVersionId, introText: null }).applicationId).toBe(1);
  });
});
