import { beforeEach, describe, expect, it } from "vitest";
import { openTestDb, type Db } from "../client.js";
import { ImmutableRecordError, InvalidTransitionError, SubmissionRefusedError } from "../errors.js";
import { at, seedCv, seedJob, T0 } from "../test-helpers.js";
import type { CvVersion, Job } from "../types.js";
import { addApprovalDomain, checkApproval, consumeApproval, createApproval, getApproval } from "./approvals.js";
import { clearJobInjection, flagJobInjection, getJob } from "./jobs.js";
import {
  createApplication,
  deleteJobSnapshot,
  deleteSubmission,
  getApplication,
  getApplicationByJob,
  getSubmissionRecord,
  importApplication,
  listApplications,
  recordSubmission,
  transitionApplication,
  updateJobSnapshot,
  updateSubmission,
  type CompleteSnapshotInput,
  type SubmissionInput,
} from "./applications.js";

let db: Db;
let job: Job;
let cv: CvVersion;
beforeEach(() => {
  db = openTestDb();
  job = seedJob(db);
  cv = seedCv(db, job);
});

const SUBMISSION: SubmissionInput = {
  finalUrl: "https://itviec.com/applied/1234",
  fields: [
    { label: "Full name", name: "name", value: "Ba Huynh", source: "master_cv" },
    { label: "Expected salary (VND) · optional", name: "salary", value: null, source: "skipped" },
  ],
  introText: "Hi NovaPay team…",
  consentTicked: true,
  consentText: "I agree to the processing of my personal data",
  uploadedFilename: "BA_HUYNH_NOVAPAY_EN.pdf",
  uploadedSha256: "a".repeat(64),
  uploadedPath: "data/applications/1/BA_HUYNH_NOVAPAY_EN.pdf",
  preSubmitScreenshotPath: "data/applications/1/pre_submit.png",
  confirmationScreenshotPath: "data/applications/1/confirmation.png",
  confirmationText: "Application sent",
};

/** A dry run fills the form but never clicks submit, so there is no confirmation. */
const DRY: SubmissionInput = { ...SUBMISSION, confirmationText: null, confirmationScreenshotPath: null };

const SNAPSHOT: CompleteSnapshotInput = {
  url: "https://itviec.com/it-jobs/senior-frontend-engineer-react-nextjs-novapay-1234",
  title: "Senior Frontend Engineer (React/Next.js)",
  company: "NovaPay",
  salaryText: "2,000–2,800 USD",
  jdText: "We are looking for…",
  pageScreenshotPath: "data/applications/1/jd.png",
};

describe("approvals (UC-08, §10.2 rule 1)", () => {
  it("creates a single-use token bound to job, CV version and domains, valid 24 h", () => {
    const a = createApproval(db, { jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"] }, { now: T0 });
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.expiresAt).toBe(new Date(T0.getTime() + 24 * 3600_000).toISOString());
    expect(getApproval(db, a.token)?.usedAt).toBeNull();
  });

  it("checks job, CV version, domain and expiry", () => {
    const { token } = createApproval(db, { jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"] }, { now: T0 });
    const ok = { jobId: job.id, cvVersionId: cv.id, now: at(60) };
    expect(checkApproval(db, token, ok)).toMatchObject({ ok: true });
    expect(checkApproval(db, token, { ...ok, domain: "www.itviec.com" })).toMatchObject({ ok: true });
    expect(checkApproval(db, token, { ...ok, domain: "evil-itviec.com" })).toEqual({ ok: false, reason: "domain_mismatch" });
    expect(checkApproval(db, token, { ...ok, jobId: 999 })).toEqual({ ok: false, reason: "job_mismatch" });
    expect(checkApproval(db, token, { ...ok, cvVersionId: 999 })).toEqual({ ok: false, reason: "cv_mismatch" });
    expect(checkApproval(db, token, { ...ok, now: at(24 * 3600) })).toEqual({ ok: false, reason: "expired" });
    expect(checkApproval(db, "nope", ok)).toEqual({ ok: false, reason: "not_found" });
  });

  it("can be consumed once; reuse is denied (UC-11f)", () => {
    const { token } = createApproval(db, { jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"] }, { now: T0 });
    const expect_ = { jobId: job.id, cvVersionId: cv.id, now: at(5) };
    expect(consumeApproval(db, token, expect_)).toMatchObject({ ok: true });
    expect(consumeApproval(db, token, expect_)).toEqual({ ok: false, reason: "used" });
    expect(getApproval(db, token)?.usedAt).toBe(at(5).toISOString());
    // The trigger blocks resetting used_at even with raw SQL.
    expect(() => db.$client.prepare("UPDATE approvals SET used_at = NULL WHERE token = ?").run(token)).toThrow(/already used/);
  });

  it("refuses a token for an injection-flagged job until Ba confirms it (UC-07 b, §10.2 rule 4)", () => {
    flagJobInjection(db, job.id);
    expect(() => createApproval(db, { jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"] })).toThrow(
      InvalidTransitionError,
    );
    clearJobInjection(db, job.id, { now: T0 });
    expect(createApproval(db, { jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"] }).token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("denies (and does not use up) a token whose job was flagged after approval", () => {
    const { token } = createApproval(db, { jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"] }, { now: T0 });
    flagJobInjection(db, job.id);
    const expect_ = { jobId: job.id, cvVersionId: cv.id, now: at(5) };
    expect(checkApproval(db, token, expect_)).toEqual({ ok: false, reason: "injection_flagged" });
    expect(consumeApproval(db, token, expect_)).toEqual({ ok: false, reason: "injection_flagged" });
    expect(getApproval(db, token)?.usedAt).toBeNull();
    clearJobInjection(db, job.id, { now: at(6) });
    expect(consumeApproval(db, token, expect_)).toMatchObject({ ok: true });
  });

  it("adds a domain Ba confirmed (UC-11e)", () => {
    const { token } = createApproval(db, { jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"] });
    expect(addApprovalDomain(db, token, "novapay.breezy.hr").allowedDomains).toEqual(["itviec.com", "novapay.breezy.hr"]);
    expect(addApprovalDomain(db, token, "novapay.breezy.hr").allowedDomains).toHaveLength(2);
  });
});

describe("applications: create, one per job (§10.2 rule 5)", () => {
  it("creates an approved application with history", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id }, { now: T0 });
    expect(app).toMatchObject({
      status: "approved",
      origin: "app",
      submittedAt: null,
      statusHistory: [{ status: "approved", at: T0.toISOString(), note: null }],
    });
    expect(getApplicationByJob(db, job.id)?.id).toBe(app.id);
  });

  it("rejects a second application for the same job unless reapply", () => {
    createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    expect(() => createApplication(db, { jobId: job.id, cvVersionId: cv.id })).toThrow(/UNIQUE/);
    expect(createApplication(db, { jobId: job.id, cvVersionId: cv.id, reapply: true }).reapply).toBe(true);
  });
});

describe("application status transitions (UC-11, UC-13)", () => {
  it("follows submit flow and manual tracking, appending history", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id }, { now: T0 });
    transitionApplication(db, app.id, "paused", { now: at(1), note: "notice period?" });
    transitionApplication(db, app.id, "approved", { now: at(2) });
    recordSubmission(db, { applicationId: app.id, submission: SUBMISSION, snapshot: SNAPSHOT }, { now: at(3) });
    transitionApplication(db, app.id, "interviewing", { now: at(4), by: "manual" });
    const offer = transitionApplication(db, app.id, "offer", { now: at(5), by: "manual" });
    expect(offer.statusHistory.map((h) => h.status)).toEqual(["approved", "paused", "approved", "submitted", "interviewing", "offer"]);
    expect(offer.statusHistory[1]).toEqual({ status: "paused", at: at(1).toISOString(), note: "notice period?" });
  });

  it("rejects invalid transitions", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    expect(() => transitionApplication(db, app.id, "interviewing")).toThrow(InvalidTransitionError);
    transitionApplication(db, app.id, "needs_check");
    expect(() => transitionApplication(db, app.id, "approved")).toThrow(InvalidTransitionError);
    expect(transitionApplication(db, app.id, "submitted", { by: "manual" }).status).toBe("submitted");
    expect(() => transitionApplication(db, app.id, "approved", { by: "manual" })).toThrow(InvalidTransitionError);
    expect(() => transitionApplication(db, app.id, "needs_check", { by: "manual" })).toThrow(InvalidTransitionError);
  });

  it("treats a same-status update as a no-op", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    expect(transitionApplication(db, app.id, "approved").statusHistory).toHaveLength(1);
  });

  it("lets Ba correct a mis-click among post-submit statuses; the history keeps both (PM M3)", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id }, { now: T0 });
    recordSubmission(db, { applicationId: app.id, submission: SUBMISSION, snapshot: SNAPSHOT }, { now: at(1) });
    transitionApplication(db, app.id, "rejected", { now: at(2), by: "manual" });
    transitionApplication(db, app.id, "interviewing", { now: at(3), by: "manual", note: "mis-click" });
    const back = transitionApplication(db, app.id, "submitted", { now: at(4), by: "manual" });
    expect(back.statusHistory.map((h) => h.status)).toEqual(["approved", "submitted", "rejected", "interviewing", "submitted"]);
    expect(() => transitionApplication(db, app.id, "paused", { by: "manual" })).toThrow(InvalidTransitionError);
    expect(() => transitionApplication(db, app.id, "needs_check", { by: "manual" })).toThrow(InvalidTransitionError);
    expect(() => transitionApplication(db, app.id, "failed", { by: "manual" })).toThrow(InvalidTransitionError);
  });

  it("the orchestrator only moves an application within the apply flow; Ba only after it", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    expect(() => transitionApplication(db, app.id, "paused", { by: "manual" })).toThrow(InvalidTransitionError);
    expect(() => transitionApplication(db, app.id, "failed", { by: "manual" })).toThrow(InvalidTransitionError);
    recordSubmission(db, { applicationId: app.id, submission: SUBMISSION, snapshot: SNAPSHOT });
    expect(() => transitionApplication(db, app.id, "interviewing")).toThrow(InvalidTransitionError);
    expect(transitionApplication(db, app.id, "interviewing", { by: "manual" }).status).toBe("interviewing");
  });

  it("blocks shrinking the history in SQL (append-only trigger)", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    transitionApplication(db, app.id, "paused");
    expect(() =>
      db.$client.prepare("UPDATE applications SET status_history_json = '[]' WHERE id = ?").run(app.id),
    ).toThrow(/append-only/);
  });

  it("blocks rewriting earlier history entries in SQL, not only shrinking (PM M3)", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id }, { now: T0 });
    transitionApplication(db, app.id, "paused", { now: at(1) });
    const rewritten = JSON.stringify([
      { status: "approved", at: T0.toISOString(), note: "edited later" },
      { status: "paused", at: at(1).toISOString(), note: null },
      { status: "approved", at: at(2).toISOString(), note: null },
    ]);
    const setHistory = db.$client.prepare("UPDATE applications SET status_history_json = ? WHERE id = ?");
    expect(() => setHistory.run(rewritten, app.id)).toThrow(/append-only/);
    expect(() => setHistory.run(JSON.stringify({ status: "approved" }), app.id)).toThrow(/append-only/);
    // Appending is what the repository does, and it stays allowed.
    expect(transitionApplication(db, app.id, "approved", { now: at(2) }).statusHistory).toHaveLength(3);
  });
});

describe("one status machine: submitted needs a record or Ba (PM M3, probe 6)", () => {
  it("the orchestrator cannot move approved or paused to submitted; nothing is marked applied", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    expect(() => transitionApplication(db, app.id, "submitted")).toThrow(InvalidTransitionError);
    expect(() => transitionApplication(db, app.id, "submitted", { by: "manual" })).toThrow(InvalidTransitionError);
    transitionApplication(db, app.id, "paused");
    expect(() => transitionApplication(db, app.id, "submitted")).toThrow(InvalidTransitionError);
    expect(() => transitionApplication(db, app.id, "submitted", { by: "manual" })).toThrow(InvalidTransitionError);
    expect(getApplication(db, app.id)).toMatchObject({ status: "paused", submittedAt: null });
    expect(getJob(db, job.id)?.status).toBe("approved");
  });

  it("Ba settles a needs_check as submitted (UC-11 c); the orchestrator cannot", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    transitionApplication(db, app.id, "needs_check", { note: "no confirmation detected" });
    expect(() => transitionApplication(db, app.id, "submitted")).toThrow(InvalidTransitionError);
    expect(transitionApplication(db, app.id, "submitted", { by: "manual" }).status).toBe("submitted");
    expect(getJob(db, job.id)?.status).toBe("applied");
  });
});

describe("dry runs (PM M3)", () => {
  it("a dry run does not take the job's one-application slot (probe 1b)", () => {
    const dry = createApplication(db, { jobId: job.id, cvVersionId: cv.id, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, reapply: false });
    expect(createApplication(db, { jobId: job.id, cvVersionId: cv.id })).toMatchObject({ dryRun: false, reapply: false });
    // A second real application still needs "apply again"; another dry run does not.
    expect(() => createApplication(db, { jobId: job.id, cvVersionId: cv.id })).toThrow(/UNIQUE/);
    expect(createApplication(db, { jobId: job.id, cvVersionId: cv.id, dryRun: true }).dryRun).toBe(true);
  });

  it("a dry run never reaches submitted and never marks the job applied (probe 1a)", () => {
    const dry = createApplication(db, { jobId: job.id, cvVersionId: cv.id, dryRun: true });
    recordSubmission(db, { applicationId: dry.id, dryRun: true, submission: DRY, snapshot: SNAPSHOT });
    expect(() => transitionApplication(db, dry.id, "submitted", { by: "manual" })).toThrow(InvalidTransitionError);
    expect(getApplication(db, dry.id)?.status).toBe("needs_check");
    expect(getJob(db, job.id)?.status).toBe("approved");
    // Ba closes the dry run.
    expect(transitionApplication(db, dry.id, "failed", { by: "manual" }).status).toBe("failed");
  });

  it("SQL triggers keep a dry run out of every post-submit status and keep its flag", () => {
    const dry = createApplication(db, { jobId: job.id, cvVersionId: cv.id, dryRun: true });
    const setStatus = db.$client.prepare("UPDATE applications SET status = ? WHERE id = ?");
    for (const status of ["submitted", "interviewing", "rejected", "no_response"]) {
      expect(() => setStatus.run(status, dry.id)).toThrow(/dry run/);
    }
    const insertDry = db.$client.prepare(
      "INSERT INTO applications(job_id, cv_version_id, status, origin, status_history_json, dry_run, created_at) VALUES (?, ?, 'submitted', 'app', '[]', 1, ?)",
    );
    expect(() => insertDry.run(job.id, cv.id, T0.toISOString())).toThrow(/dry run/);
    const setFlag = db.$client.prepare("UPDATE applications SET dry_run = ? WHERE id = ?");
    expect(() => setFlag.run(0, dry.id)).toThrow(/dry run/);
    const real = createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    expect(() => setFlag.run(1, real.id)).toThrow(/dry run/);
  });

  it("recordSubmission refuses a dry-run flag that differs from the application's and writes nothing", () => {
    const real = createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    const dry = createApplication(db, { jobId: job.id, cvVersionId: cv.id, dryRun: true });
    for (const [app, dryRun] of [
      [real, true],
      [dry, false],
    ] as const) {
      let caught: unknown;
      try {
        recordSubmission(db, { applicationId: app.id, dryRun, status: "needs_check", submission: DRY, snapshot: SNAPSHOT });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SubmissionRefusedError);
      expect((caught as SubmissionRefusedError).reason).toBe("dry_run_mismatch");
      expect(getApplication(db, app.id)?.status).toBe("approved");
      expect(getSubmissionRecord(db, app.id)?.submission).toBeUndefined();
    }
  });

  it("'already applied' lookups ignore dry runs; lists can filter them", () => {
    const dry = createApplication(db, { jobId: job.id, cvVersionId: cv.id, dryRun: true }, { now: at(1) });
    expect(getApplicationByJob(db, job.id)).toBeUndefined();
    expect(getApplicationByJob(db, job.id, { includeDryRuns: true })?.id).toBe(dry.id);
    const real = createApplication(db, { jobId: job.id, cvVersionId: cv.id }, { now: at(2) });
    const laterDry = createApplication(db, { jobId: job.id, cvVersionId: cv.id, dryRun: true }, { now: at(3) });
    expect(getApplicationByJob(db, job.id)?.id).toBe(real.id);
    expect(getApplicationByJob(db, job.id, { includeDryRuns: true })?.id).toBe(laterDry.id);
    expect(listApplications(db, { dryRun: false }).map((a) => a.id)).toEqual([real.id]);
    expect(listApplications(db, { dryRun: true }).map((a) => a.id)).toEqual([laterDry.id, dry.id]);
    expect(listApplications(db)).toHaveLength(3);
  });
});

describe("submission record (§9.1)", () => {
  it("writes application + submission + JD snapshot in one transaction", () => {
    const approval = createApproval(db, { jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"] }, { now: T0 });
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id }, { now: T0 });
    const rec = recordSubmission(
      db,
      { applicationId: app.id, submission: { ...SUBMISSION, approvalToken: approval.token }, snapshot: SNAPSHOT },
      { now: at(30) },
    );
    expect(rec.application).toMatchObject({ status: "submitted", submittedAt: at(30).toISOString() });
    expect(rec.submission).toMatchObject({ ...SUBMISSION, approvalToken: approval.token, submittedAt: at(30).toISOString() });
    expect(rec.snapshot).toMatchObject({ ...SNAPSHOT, capturedAt: at(30).toISOString() });

    const full = getSubmissionRecord(db, app.id);
    expect(full?.job.id).toBe(job.id);
    expect(full?.company?.name).toBe("NovaPay");
    expect(full?.cvVersion?.id).toBe(cv.id);
    expect(full?.approval?.token).toBe(approval.token);
    expect(full?.submission?.fields).toHaveLength(2);
  });

  it("can record a needs_check outcome (UC-11c)", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    const rec = recordSubmission(db, { applicationId: app.id, status: "needs_check", submission: SUBMISSION, snapshot: SNAPSHOT });
    expect(rec.application.status).toBe("needs_check");
    expect(rec.submission.dryRun).toBe(false);
  });

  it("records a dry-run Apply as needs_check with dryRun, never as submitted (§12)", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id, dryRun: true }, { now: T0 });
    expect(() =>
      recordSubmission(db, { applicationId: app.id, dryRun: true, status: "submitted", submission: DRY, snapshot: SNAPSHOT }),
    ).toThrow(InvalidTransitionError);
    const rec = recordSubmission(db, { applicationId: app.id, dryRun: true, submission: DRY, snapshot: SNAPSHOT }, { now: at(9) });
    expect(rec.application.status).toBe("needs_check");
    expect(rec.application.statusHistory.at(-1)).toEqual({
      status: "needs_check",
      at: at(9).toISOString(),
      note: "dry run: form filled, not submitted",
    });
    expect(rec.submission.dryRun).toBe(true);
    // Nothing was sent, so the job is not "applied".
    expect(getSubmissionRecord(db, app.id)?.job.status).toBe("approved");
  });

  it("rolls back everything if any part fails", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    expect(() =>
      recordSubmission(db, {
        applicationId: app.id,
        submission: { ...SUBMISSION, approvalToken: "missing-token" }, // FK violation
        snapshot: SNAPSHOT,
      }),
    ).toThrow();
    expect(getApplication(db, app.id)?.status).toBe("approved");
    expect(getSubmissionRecord(db, app.id)?.submission).toBeUndefined();
    expect(getSubmissionRecord(db, app.id)?.snapshot).toBeUndefined();
  });

  it("refuses to write a second record for the same application", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    recordSubmission(db, { applicationId: app.id, submission: SUBMISSION, snapshot: SNAPSHOT });
    expect(() => recordSubmission(db, { applicationId: app.id, submission: SUBMISSION, snapshot: SNAPSHOT })).toThrow(
      ImmutableRecordError,
    );
  });

  describe("immutability", () => {
    let appId: number;
    beforeEach(() => {
      appId = createApplication(db, { jobId: job.id, cvVersionId: cv.id }).id;
      recordSubmission(db, { applicationId: appId, submission: SUBMISSION, snapshot: SNAPSHOT });
    });

    it("repository API refuses update/delete", () => {
      expect(() => updateSubmission()).toThrow(ImmutableRecordError);
      expect(() => deleteSubmission()).toThrow(ImmutableRecordError);
      expect(() => updateJobSnapshot()).toThrow(ImmutableRecordError);
      expect(() => deleteJobSnapshot()).toThrow(ImmutableRecordError);
    });

    it("SQLite triggers block UPDATE/DELETE on submissions", () => {
      expect(() => db.$client.prepare("UPDATE submissions SET intro_text = 'x' WHERE application_id = ?").run(appId)).toThrow(
        /immutable/,
      );
      expect(() => db.$client.prepare("DELETE FROM submissions WHERE application_id = ?").run(appId)).toThrow(/immutable/);
    });

    it("SQLite triggers block UPDATE/DELETE on job_snapshots", () => {
      expect(() => db.$client.prepare("UPDATE job_snapshots SET jd_text = 'x' WHERE application_id = ?").run(appId)).toThrow(
        /immutable/,
      );
      expect(() => db.$client.prepare("DELETE FROM job_snapshots WHERE application_id = ?").run(appId)).toThrow(/immutable/);
    });

    it("recorded applications cannot be deleted or re-pointed, only change status", () => {
      expect(() => db.$client.prepare("DELETE FROM applications WHERE id = ?").run(appId)).toThrow(/cannot be deleted/);
      expect(() => db.$client.prepare("UPDATE applications SET cv_version_id = NULL WHERE id = ?").run(appId)).toThrow(
        /only allow status/,
      );
      expect(transitionApplication(db, appId, "rejected", { by: "manual" }).status).toBe("rejected");
    });

    it("a recorded application's created_at and dry-run flag are frozen too (PM M3)", () => {
      const setCreatedAt = db.$client.prepare("UPDATE applications SET created_at = ? WHERE id = ?");
      expect(() => setCreatedAt.run(at(99).toISOString(), appId)).toThrow(/only allow status/);
      expect(() => db.$client.prepare("UPDATE applications SET dry_run = 1 WHERE id = ?").run(appId)).toThrow(/dry run|only allow status/);
    });
  });
});

describe("imported applications (UC-13)", () => {
  it("stores a partial record with origin imported", () => {
    const dekon = seedJob(db, {
      source: "topcv",
      url: "https://www.topcv.vn/viec-lam/senior-developer-nodejs-reactjs-ai/2316742.html",
      title: "Senior Developer (NodeJS, ReactJS, AI)",
      company: "DEKON",
      location: "Ho Chi Minh City",
      language: "vi",
    });
    const rec = importApplication(
      db,
      {
        jobId: dekon.id,
        submittedAt: "2026-10-10T08:40:00.000Z",
        submission: {
          fields: [{ label: "CV", name: null, value: "BA_HUYNH_DEKON_Figma_EN.pdf", source: "generated" }],
          consentTicked: true,
          consentText: "Employer personal-data-use agreement (TopCV)",
          uploadedFilename: "BA_HUYNH_DEKON_Figma_EN.pdf",
          confirmationText: "Ứng tuyển việc làm thành công!",
        },
      },
      { now: T0 },
    );
    expect(rec.application).toMatchObject({ origin: "imported", status: "submitted", cvVersionId: null, submittedAt: "2026-10-10T08:40:00.000Z" });
    expect(rec.submission?.uploadedSha256).toBeNull();
    expect(rec.snapshot).toBeUndefined();
    expect(getSubmissionRecord(db, rec.application.id)?.snapshot).toBeUndefined();
    expect(listApplications(db, { origin: "imported" })).toHaveLength(1);
  });

  it("lists applications filtered by status, newest first", () => {
    const a = createApplication(db, { jobId: job.id, cvVersionId: cv.id }, { now: at(1) });
    transitionApplication(db, a.id, "needs_check");
    expect(listApplications(db, { status: "needs_check" }).map((x) => x.id)).toEqual([a.id]);
    expect(listApplications(db, { status: "submitted" })).toEqual([]);
  });
});
