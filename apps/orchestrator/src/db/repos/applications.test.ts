import { beforeEach, describe, expect, it } from "vitest";
import { openTestDb, type Db } from "../client.js";
import { ImmutableRecordError, InvalidTransitionError } from "../errors.js";
import { at, seedCv, seedJob, T0 } from "../test-helpers.js";
import type { CvVersion, Job } from "../types.js";
import { addApprovalDomain, checkApproval, consumeApproval, createApproval, getApproval } from "./approvals.js";
import {
  canTransitionApplication,
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
  type SnapshotInput,
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

const SNAPSHOT: SnapshotInput = {
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
      statusHistory: [{ status: "approved", at: T0.toISOString() }],
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
    transitionApplication(db, app.id, "interviewing", { now: at(4) });
    const offer = transitionApplication(db, app.id, "offer", { now: at(5) });
    expect(offer.statusHistory.map((h) => h.status)).toEqual(["approved", "paused", "approved", "submitted", "interviewing", "offer"]);
    expect(offer.statusHistory[1]).toEqual({ status: "paused", at: at(1).toISOString(), note: "notice period?" });
  });

  it("rejects invalid transitions", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    expect(() => transitionApplication(db, app.id, "interviewing")).toThrow(InvalidTransitionError);
    transitionApplication(db, app.id, "needs_check");
    expect(() => transitionApplication(db, app.id, "approved")).toThrow(InvalidTransitionError);
    expect(transitionApplication(db, app.id, "submitted").status).toBe("submitted");
    expect(() => transitionApplication(db, app.id, "approved")).toThrow(InvalidTransitionError);
    expect(() => transitionApplication(db, app.id, "needs_check")).toThrow(InvalidTransitionError);
  });

  it("treats a same-status update as a no-op", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    expect(transitionApplication(db, app.id, "approved").statusHistory).toHaveLength(1);
  });

  it("lets Ba correct manual statuses among post-submit states", () => {
    expect(canTransitionApplication("rejected", "interviewing")).toBe(true);
    expect(canTransitionApplication("no_response", "interviewing")).toBe(true);
    expect(canTransitionApplication("submitted", "paused")).toBe(false);
    expect(canTransitionApplication("failed", "submitted")).toBe(false);
  });

  it("blocks shrinking the history in SQL (append-only trigger)", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    transitionApplication(db, app.id, "submitted");
    expect(() =>
      db.$client.prepare("UPDATE applications SET status_history_json = '[]' WHERE id = ?").run(app.id),
    ).toThrow(/append-only/);
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
      expect(transitionApplication(db, appId, "rejected").status).toBe("rejected");
    });
  });
});

describe("imported applications (UC-13)", () => {
  it("stores a partial record with origin imported", () => {
    const dekon = seedJob(db, {
      source: "TopCV",
      url: "https://www.topcv.vn/viec-lam/senior-developer-nodejs-reactjs-ai/2316742.html",
      title: "Senior Developer (NodeJS, ReactJS, AI)",
      company: "DEKON",
      location: "Ho Chi Minh City",
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
