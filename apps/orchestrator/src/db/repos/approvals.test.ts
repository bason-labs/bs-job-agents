// Approval tokens (UC-08, UC-11, §10.2 rules 1, 2 and 4) and their binding to one application
// (PM phase 1, M2): a token authorises one application; a used token only re-validates a
// resume of that application while nothing was recorded and the token has not expired.
import { AppEventSchema } from "@bs-job-agents/shared";
import { cvOutputFixture } from "@bs-job-agents/shared/fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { openTestDb, type Db } from "../client.js";
import { ApprovalRefusedError, InvalidTransitionError } from "../errors.js";
import { at, seedCv, seedJob, T0 } from "../test-helpers.js";
import type { Application, Approval, CvVersion, Job } from "../types.js";
import {
  approveApplication,
  createApplication,
  recordSubmission,
  transitionApplication,
  type CompleteSnapshotInput,
  type SubmissionInput,
} from "./applications.js";
import {
  APPROVAL_DENIALS,
  SAFETY_REASON_FOR_APPROVAL_DENIAL,
  addApprovalDomain,
  checkApproval,
  checkApprovalForResume,
  consumeApproval,
  createApproval,
  getApproval,
} from "./approvals.js";
import { createCvVersion } from "./cv.js";
import { clearJobInjection, flagJobInjection } from "./jobs.js";

let db: Db;
let job: Job;
let cv: CvVersion;
beforeEach(() => {
  db = openTestDb();
  job = seedJob(db);
  cv = seedCv(db, job);
});

const DAY = 24 * 3600;

/** UC-08: Ba approves the card → application + bound token, valid 24 h. */
function approve(opts: { now?: Date; dryRun?: boolean; reapply?: boolean } = {}): { application: Application; approval: Approval } {
  return approveApplication(
    db,
    { jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"], dryRun: opts.dryRun, reapply: opts.reapply },
    { now: opts.now ?? T0 },
  );
}

function refusal(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApprovalRefusedError) return err.reason;
    throw err;
  }
  return undefined;
}

const SUBMISSION: SubmissionInput = {
  finalUrl: "https://itviec.com/applied/1234",
  fields: [{ label: "Full name", name: "name", value: "Ba Huynh", source: "master_cv" }],
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

const SNAPSHOT: CompleteSnapshotInput = {
  url: "https://itviec.com/it-jobs/senior-frontend-engineer-react-nextjs-novapay-1234",
  title: "Senior Frontend Engineer (React/Next.js)",
  company: "NovaPay",
  jdText: "We are looking for…",
};

/** Apply ran (its first spawn consumed the token) and the orchestrator wrote a needs_check record. */
function recordNeedsCheck(application: Application, approval: Approval): void {
  if (!getApproval(db, approval.token)?.usedAt) {
    consumeApproval(db, approval.token, { applicationId: application.id, jobId: job.id, cvVersionId: cv.id, now: at(5) });
  }
  recordSubmission(db, {
    applicationId: application.id,
    status: "needs_check",
    dryRun: application.dryRun,
    submission: { ...SUBMISSION, approvalToken: approval.token },
    snapshot: SNAPSHOT,
  });
}

describe("approval tokens (UC-08, §10.2 rule 1)", () => {
  it("creates a single-use token bound to the application, job, CV version and domains, valid 24 h", () => {
    const { application, approval } = approve();
    expect(approval.token).toMatch(/^[0-9a-f]{64}$/);
    expect(approval).toMatchObject({ applicationId: application.id, jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"] });
    expect(approval.expiresAt).toBe(new Date(T0.getTime() + DAY * 1000).toISOString());
    expect(getApproval(db, approval.token)?.usedAt).toBeNull();
    expect(application).toMatchObject({ status: "approved", jobId: job.id, cvVersionId: cv.id });
  });

  it("never lives longer than 24 h, whatever the caller asks (UC-08)", () => {
    const longer = approveApplication(
      db,
      { jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"], ttlMs: 7 * DAY * 1000 },
      { now: T0 },
    );
    expect(longer.approval.expiresAt).toBe(at(DAY).toISOString());
    const shorter = approveApplication(
      db,
      { jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"], ttlMs: 60_000, dryRun: true },
      { now: T0 },
    );
    expect(shorter.approval.expiresAt).toBe(at(60).toISOString());
  });

  it("checks application, job, CV version, domain and expiry", () => {
    const { application, approval } = approve();
    const ok = { applicationId: application.id, jobId: job.id, cvVersionId: cv.id, now: at(60) };
    expect(checkApproval(db, approval.token, ok)).toMatchObject({ ok: true });
    expect(checkApproval(db, approval.token, { ...ok, domain: "www.itviec.com" })).toMatchObject({ ok: true });
    expect(checkApproval(db, approval.token, { ...ok, domain: "evil-itviec.com" })).toEqual({ ok: false, reason: "domain_mismatch" });
    expect(checkApproval(db, approval.token, { ...ok, applicationId: 999 })).toEqual({ ok: false, reason: "application_mismatch" });
    expect(checkApproval(db, approval.token, { ...ok, jobId: 999 })).toEqual({ ok: false, reason: "job_mismatch" });
    expect(checkApproval(db, approval.token, { ...ok, cvVersionId: 999 })).toEqual({ ok: false, reason: "cv_mismatch" });
    expect(checkApproval(db, approval.token, { ...ok, now: at(DAY) })).toEqual({ ok: false, reason: "expired" });
    expect(checkApproval(db, "nope", ok)).toEqual({ ok: false, reason: "not_found" });
  });

  it("can be consumed once; reuse is denied (UC-11f)", () => {
    const { application, approval } = approve();
    const expect_ = { applicationId: application.id, jobId: job.id, cvVersionId: cv.id, now: at(5) };
    expect(consumeApproval(db, approval.token, expect_)).toMatchObject({ ok: true });
    expect(consumeApproval(db, approval.token, expect_)).toEqual({ ok: false, reason: "used" });
    expect(getApproval(db, approval.token)?.usedAt).toBe(at(5).toISOString());
    // The trigger blocks resetting used_at even with raw SQL.
    expect(() => db.$client.prepare("UPDATE approvals SET used_at = NULL WHERE token = ?").run(approval.token)).toThrow(/already used/);
  });

  it("refuses a token for an injection-flagged job until Ba confirms it (UC-07 b, §10.2 rule 4)", () => {
    flagJobInjection(db, job.id);
    expect(() => approve()).toThrow(InvalidTransitionError);
    clearJobInjection(db, job.id, { now: T0 });
    expect(approve().approval.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("denies (and does not use up) a token whose job was flagged after approval", () => {
    const { application, approval } = approve();
    flagJobInjection(db, job.id);
    const expect_ = { applicationId: application.id, jobId: job.id, cvVersionId: cv.id, now: at(5) };
    expect(checkApproval(db, approval.token, expect_)).toEqual({ ok: false, reason: "injection_flagged" });
    expect(consumeApproval(db, approval.token, expect_)).toEqual({ ok: false, reason: "injection_flagged" });
    expect(getApproval(db, approval.token)?.usedAt).toBeNull();
    clearJobInjection(db, job.id, { now: at(6) });
    expect(consumeApproval(db, approval.token, expect_)).toMatchObject({ ok: true });
  });

  it("adds a domain Ba confirmed (UC-11e)", () => {
    const { approval } = approve();
    expect(addApprovalDomain(db, approval.token, "novapay.breezy.hr").allowedDomains).toEqual(["itviec.com", "novapay.breezy.hr"]);
    expect(addApprovalDomain(db, approval.token, "novapay.breezy.hr").allowedDomains).toHaveLength(2);
  });
});

describe("a token is bound to one application (PM M2)", () => {
  it("UC-08 creates the application and its token in one transaction; neither exists if one fails", () => {
    flagJobInjection(db, job.id);
    expect(() => approve()).toThrow(InvalidTransitionError);
    expect(db.$client.prepare("SELECT count(*) AS n FROM applications").get()).toEqual({ n: 0 });
    expect(db.$client.prepare("SELECT count(*) AS n FROM approvals").get()).toEqual({ n: 0 });
  });

  it("createApproval refuses an application of another job or CV version", () => {
    const other = seedJob(db, { ...seedJobInput("https://itviec.com/it-jobs/other-2"), title: "Backend Engineer" });
    const otherCv = seedCv(db, other);
    const app = createApplication(db, { jobId: other.id, cvVersionId: otherCv.id });
    expect(refusal(() => createApproval(db, { applicationId: app.id, jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"] }))).toBe(
      "application_mismatch",
    );
    const vi = seedCv(db, other);
    expect(refusal(() => createApproval(db, { applicationId: app.id, jobId: other.id, cvVersionId: vi.id, allowedDomains: ["itviec.com"] }))).toBe(
      "application_mismatch",
    );
  });

  it("createApproval refuses an application that has a record or left the apply flow", () => {
    const { application, approval } = approve();
    const again = { applicationId: application.id, jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"] };
    transitionApplication(db, application.id, "failed", { now: at(1) });
    expect(refusal(() => createApproval(db, again, { now: at(DAY + 1) }))).toBe("application_closed");

    const second = approve({ reapply: true, now: at(2) });
    recordNeedsCheck(second.application, second.approval);
    expect(
      refusal(() => createApproval(db, { ...again, applicationId: second.application.id }, { now: at(DAY + 10) })),
    ).toBe("application_recorded");
    expect(approval.applicationId).toBe(application.id);
  });

  it("after expiry Ba approves again: a new token for the same application; never two live ones", () => {
    const { application, approval } = approve();
    const again = { applicationId: application.id, jobId: job.id, cvVersionId: cv.id, allowedDomains: ["itviec.com"] };
    expect(refusal(() => createApproval(db, again, { now: at(60) }))).toBe("token_live");
    const renewed = createApproval(db, again, { now: at(DAY) });
    expect(renewed.token).not.toBe(approval.token);
    expect(renewed.applicationId).toBe(application.id);
    expect(checkApproval(db, renewed.token, { ...again, now: at(DAY + 1) })).toMatchObject({ ok: true });
  });

  it("a token cannot be consumed for another application, even of the same job (a dry run's token)", () => {
    const dry = approve({ dryRun: true });
    const real = approve({ now: at(1) });
    const forReal = { applicationId: real.application.id, jobId: job.id, cvVersionId: cv.id, now: at(5) };
    expect(consumeApproval(db, dry.approval.token, forReal)).toEqual({ ok: false, reason: "application_mismatch" });
    expect(getApproval(db, dry.approval.token)?.usedAt).toBeNull();
    expect(consumeApproval(db, real.approval.token, forReal)).toMatchObject({ ok: true });
  });

  it("a token whose application left the apply flow cannot be consumed", () => {
    const { application, approval } = approve();
    transitionApplication(db, application.id, "failed", { now: at(1) });
    const expect_ = { applicationId: application.id, jobId: job.id, cvVersionId: cv.id, now: at(5) };
    expect(consumeApproval(db, approval.token, expect_)).toEqual({ ok: false, reason: "application_closed" });
    expect(getApproval(db, approval.token)?.usedAt).toBeNull();
  });
});

describe("checkApprovalForResume (PM M2: UC-11 a/b/e, UC-12, UC-17)", () => {
  let application: Application;
  let approval: Approval;
  let resume: { applicationId: number; jobId: number; cvVersionId: number; domain: string; now: Date };
  beforeEach(() => {
    ({ application, approval } = approve());
    resume = { applicationId: application.id, jobId: job.id, cvVersionId: cv.id, domain: "itviec.com", now: at(3600) };
    // First spawn: the trust guard consumes the token.
    expect(consumeApproval(db, approval.token, { ...resume, now: at(5) })).toMatchObject({ ok: true });
  });

  it("re-validates the used token for the same application, approved or paused", () => {
    expect(checkApprovalForResume(db, approval.token, resume)).toMatchObject({ ok: true, approval: { token: approval.token } });
    transitionApplication(db, application.id, "paused", { now: at(60), note: "notice period?" });
    expect(checkApprovalForResume(db, approval.token, resume)).toMatchObject({ ok: true });
    // It stays read-only: the token keeps its first use.
    expect(getApproval(db, approval.token)?.usedAt).toBe(at(5).toISOString());
  });

  it("denies another application", () => {
    const other = approve({ dryRun: true, now: at(1) });
    expect(checkApprovalForResume(db, approval.token, { ...resume, applicationId: other.application.id })).toEqual({
      ok: false,
      reason: "application_mismatch",
    });
  });

  it("denies an application that has a record", () => {
    recordNeedsCheck(application, approval);
    expect(checkApprovalForResume(db, approval.token, resume)).toEqual({ ok: false, reason: "application_recorded" });
  });

  it.each(["needs_check", "failed"] as const)("denies an application in %s", (status) => {
    transitionApplication(db, application.id, status, { now: at(60) });
    expect(checkApprovalForResume(db, approval.token, resume)).toEqual({ ok: false, reason: "application_closed" });
  });

  it("denies an application Ba marked submitted", () => {
    transitionApplication(db, application.id, "needs_check", { now: at(60) });
    transitionApplication(db, application.id, "submitted", { now: at(61), by: "manual" });
    expect(checkApprovalForResume(db, approval.token, resume)).toEqual({ ok: false, reason: "application_closed" });
  });

  it("denies an expired token: the 24 h limit applies to resumes too", () => {
    expect(checkApprovalForResume(db, approval.token, { ...resume, now: at(DAY - 1) })).toMatchObject({ ok: true });
    expect(checkApprovalForResume(db, approval.token, { ...resume, now: at(DAY) })).toEqual({ ok: false, reason: "expired" });
  });

  it("denies a token that was never used (the first spawn consumes it instead)", () => {
    const fresh = approve({ dryRun: true, now: at(1) });
    expect(
      checkApprovalForResume(db, fresh.approval.token, { ...resume, applicationId: fresh.application.id }),
    ).toEqual({ ok: false, reason: "not_used" });
  });

  it("still checks the domain, the job, the CV version and the injection flag", () => {
    expect(checkApprovalForResume(db, approval.token, { ...resume, domain: "mail.google.com" })).toEqual({
      ok: false,
      reason: "domain_mismatch",
    });
    expect(checkApprovalForResume(db, approval.token, { ...resume, jobId: 999 })).toEqual({ ok: false, reason: "job_mismatch" });
    expect(checkApprovalForResume(db, approval.token, { ...resume, cvVersionId: 999 })).toEqual({ ok: false, reason: "cv_mismatch" });
    flagJobInjection(db, job.id);
    expect(checkApprovalForResume(db, approval.token, resume)).toEqual({ ok: false, reason: "injection_flagged" });
    expect(checkApprovalForResume(db, "nope", resume)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("approval rows are immutable except used_at and growing domains (PM M2)", () => {
  it("SQL refuses to change anything but used_at (once) and allowed_domains", () => {
    const { approval } = approve();
    const other = approve({ dryRun: true, now: at(1) });
    const set = (column: string, value: unknown) =>
      db.$client.prepare(`UPDATE approvals SET ${column} = ? WHERE token = ?`).run(value, approval.token);
    expect(() => set("expires_at", at(10 * DAY).toISOString())).toThrow(/immutable/);
    expect(() => set("job_id", 999)).toThrow(/immutable/);
    expect(() => set("cv_version_id", 999)).toThrow(/immutable/);
    expect(() => set("application_id", other.application.id)).toThrow(/immutable/);
    expect(() => set("created_at", at(5).toISOString())).toThrow(/immutable/);
    expect(() => set("token", "forged")).toThrow(/immutable/);
    expect(() => db.$client.prepare("DELETE FROM approvals WHERE token = ?").run(approval.token)).toThrow(/immutable/);
    expect(() => set("used_at", at(5).toISOString())).not.toThrow();
  });

  it("allowed_domains may only grow", () => {
    const { approval } = approve();
    addApprovalDomain(db, approval.token, "novapay.breezy.hr");
    const setDomains = (domains: unknown) =>
      db.$client.prepare("UPDATE approvals SET allowed_domains_json = ? WHERE token = ?").run(JSON.stringify(domains), approval.token);
    expect(() => setDomains(["itviec.com"])).toThrow(/only grow/);
    expect(() => setDomains(["novapay.breezy.hr", "itviec.com"])).toThrow(/only grow/);
    expect(() => setDomains({ "0": "itviec.com" })).toThrow(/only grow/);
    expect(() => setDomains(["itviec.com", "novapay.breezy.hr", "workday.com"])).not.toThrow();
  });

  it("allowed_domains freeze once a submission cites the token; the record panel reads this row", () => {
    const { application, approval } = approve();
    recordNeedsCheck(application, approval);
    expect(() =>
      db.$client
        .prepare("UPDATE approvals SET allowed_domains_json = ? WHERE token = ?")
        .run(JSON.stringify(["itviec.com", "novapay.breezy.hr"]), approval.token),
    ).toThrow(/only grow/);
    expect(getApproval(db, approval.token)?.allowedDomains).toEqual(["itviec.com"]);
  });
});

describe("addApprovalDomain (UC-11e, PM M2)", () => {
  it("works while the application is approved or paused", () => {
    const { application, approval } = approve();
    transitionApplication(db, application.id, "paused", { now: at(1), note: "new domain to confirm" });
    expect(addApprovalDomain(db, approval.token, "novapay.breezy.hr").allowedDomains).toEqual(["itviec.com", "novapay.breezy.hr"]);
  });

  it("refuses once the application has a record", () => {
    const { application, approval } = approve();
    recordNeedsCheck(application, approval);
    expect(refusal(() => addApprovalDomain(db, approval.token, "novapay.breezy.hr"))).toBe("application_recorded");
  });

  it.each(["needs_check", "failed"] as const)("refuses once the application is %s", (status) => {
    const { application, approval } = approve();
    transitionApplication(db, application.id, status);
    expect(refusal(() => addApprovalDomain(db, approval.token, "novapay.breezy.hr"))).toBe("application_closed");
    expect(getApproval(db, approval.token)?.allowedDomains).toEqual(["itviec.com"]);
  });
});

describe("an approval binds the approved job, CV version and file (PM M1)", () => {
  const count = (table: string) => (db.$client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

  /** A CV version of `forJob` with only some of the export done. */
  function draftCv(forJob: Job, pdf: { pdfPath: string | null; pdfSha256: string | null }): CvVersion {
    return createCvVersion(db, {
      jobId: forJob.id,
      language: "en",
      tailored: cvOutputFixture.tailored,
      figmaFrameName: "NOVAPAY_SENIOR-FE_EN_v2",
      figmaFrameUrl: null,
      ...pdf,
      masterVersion: 1,
      promptVersion: 1,
    });
  }

  it("refuses a CV version of another job (PM probe 4a)", () => {
    const other = seedJob(db, { ...seedJobInput("https://itviec.com/it-jobs/other-2"), title: "Backend Engineer" });
    const otherCv = seedCv(db, other);
    expect(refusal(() => approveApplication(db, { jobId: job.id, cvVersionId: otherCv.id, allowedDomains: ["itviec.com"] }))).toBe(
      "cv_job_mismatch",
    );
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    expect(
      refusal(() => createApproval(db, { applicationId: app.id, jobId: job.id, cvVersionId: otherCv.id, allowedDomains: ["itviec.com"] })),
    ).toBe("cv_job_mismatch");
    expect(count("approvals")).toBe(0);
  });

  it("refuses a CV version that does not exist", () => {
    const app = createApplication(db, { jobId: job.id, cvVersionId: cv.id });
    expect(refusal(() => createApproval(db, { applicationId: app.id, jobId: job.id, cvVersionId: 999, allowedDomains: ["itviec.com"] }))).toBe(
      "cv_not_found",
    );
  });

  it.each([
    ["no PDF yet", { pdfPath: null, pdfSha256: null }],
    ["a PDF without its SHA-256", { pdfPath: "data/pdf/NOVAPAY_SENIOR-FE_EN_v2.pdf", pdfSha256: null }],
    ["a SHA-256 without the PDF", { pdfPath: null, pdfSha256: "b".repeat(64) }],
    ["a malformed SHA-256", { pdfPath: "data/pdf/NOVAPAY_SENIOR-FE_EN_v2.pdf", pdfSha256: "B".repeat(64) }],
  ] as const)("refuses a CV version with %s (PM probe 4b); UC-08 then leaves nothing behind", (_label, pdf) => {
    const draft = draftCv(job, pdf);
    expect(refusal(() => approveApplication(db, { jobId: job.id, cvVersionId: draft.id, allowedDomains: ["itviec.com"] }))).toBe(
      "pdf_missing",
    );
    expect(count("applications")).toBe(0);
    expect(count("approvals")).toBe(0);
  });

  it("needs at least one valid domain; domains are normalised", () => {
    const tryDomains = (allowedDomains: string[]) =>
      refusal(() => approveApplication(db, { jobId: job.id, cvVersionId: cv.id, allowedDomains }));
    expect(tryDomains([])).toBe("no_domain");
    expect(tryDomains(["https://itviec.com/it-jobs"])).toBe("invalid_domain");
    expect(tryDomains(["itviec.com", "not a domain"])).toBe("invalid_domain");
    expect(tryDomains([" "])).toBe("invalid_domain");
    expect(count("applications")).toBe(0);
    const { approval } = approveApplication(db, { jobId: job.id, cvVersionId: cv.id, allowedDomains: [" ItViec.COM. ", "itviec.com"] });
    expect(approval.allowedDomains).toEqual(["itviec.com"]);
  });

  describe("the public-host rule (PM2 M2): a token can never name a public suffix, an IP or a local name", () => {
    it.each(["com", "vn", "com.vn", "github.io", "127.0.0.1", "192.168.1.1", "localhost", "printer.local", "COM.VN."])(
      "createApproval and addApprovalDomain refuse %s",
      (domain) => {
        expect(refusal(() => approveApplication(db, { jobId: job.id, cvVersionId: cv.id, allowedDomains: [domain] }))).toBe("invalid_domain");
        expect(count("applications")).toBe(0);
        const { approval } = approve();
        expect(refusal(() => addApprovalDomain(db, approval.token, domain))).toBe("invalid_domain");
        expect(getApproval(db, approval.token)?.allowedDomains).toEqual(["itviec.com"]);
      },
    );

    it.each(["topcv.vn", "itviec.com", "acme.wd3.myworkdayjobs.com", "Novapay.Breezy.HR"])("accepts %s", (domain) => {
      const { approval } = approveApplication(db, { jobId: job.id, cvVersionId: cv.id, allowedDomains: [domain] });
      expect(approval.allowedDomains).toEqual([domain.toLowerCase()]);
      expect(addApprovalDomain(db, approval.token, "topcv.vn").allowedDomains).toContain("topcv.vn");
    });

    it("the refusal says why", () => {
      expect(() => approveApplication(db, { jobId: job.id, cvVersionId: cv.id, allowedDomains: ["com.vn"] })).toThrow(/public suffix/);
      const { approval } = approve();
      expect(() => addApprovalDomain(db, approval.token, "192.168.1.1")).toThrow(/IP address/);
    });
  });

  it("addApprovalDomain refuses an invalid domain", () => {
    const { approval } = approve();
    expect(refusal(() => addApprovalDomain(db, approval.token, "https://novapay.breezy.hr/apply"))).toBe("invalid_domain");
    expect(getApproval(db, approval.token)?.allowedDomains).toEqual(["itviec.com"]);
  });

  it("an approved CV version's PDF can no longer be swapped (the record compares against it)", () => {
    const draft = draftCv(job, { pdfPath: "data/pdf/NOVAPAY_SENIOR-FE_EN_v2.pdf", pdfSha256: "b".repeat(64) });
    const setPdf = db.$client.prepare("UPDATE cv_versions SET pdf_sha256 = ?, pdf_path = ? WHERE id = ?");
    // Before approval the orchestrator may still re-export.
    expect(() => setPdf.run("c".repeat(64), "data/pdf/NOVAPAY_SENIOR-FE_EN_v2.pdf", draft.id)).not.toThrow();
    approveApplication(db, { jobId: job.id, cvVersionId: draft.id, allowedDomains: ["itviec.com"] });
    expect(() => setPdf.run("d".repeat(64), "data/pdf/NOVAPAY_SENIOR-FE_EN_v2.pdf", draft.id)).toThrow(/approved/);
    expect(() => setPdf.run("c".repeat(64), "data/pdf/other.pdf", draft.id)).toThrow(/approved/);
  });
});

describe("trust-guard denials become safety.denied events (§10.2 rule 8)", () => {
  it("every denial maps to a reason the shared event accepts", () => {
    expect(Object.keys(SAFETY_REASON_FOR_APPROVAL_DENIAL).sort()).toEqual([...APPROVAL_DENIALS].sort());
    for (const denial of APPROVAL_DENIALS) {
      const event = {
        id: "1",
        at: T0.toISOString(),
        type: "safety.denied",
        botName: "apply",
        taskId: "7",
        action: "apply.submit",
        reason: SAFETY_REASON_FOR_APPROVAL_DENIAL[denial],
        detail: null,
      };
      expect(AppEventSchema.safeParse(event).success, denial).toBe(true);
    }
  });

  it("keeps the existing reasons for the existing denials", () => {
    expect(SAFETY_REASON_FOR_APPROVAL_DENIAL).toMatchObject({
      not_found: "no_token",
      used: "token_used",
      expired: "token_expired",
      job_mismatch: "wrong_job",
      domain_mismatch: "wrong_domain",
      application_mismatch: "wrong_application",
      cv_mismatch: "wrong_cv",
      not_used: "token_unused",
    });
  });
});

function seedJobInput(url: string) {
  return { source: "itviec", url, title: "Senior Frontend Engineer (React/Next.js)", company: "NovaPay", language: "en", location: "Ho Chi Minh City" };
}
