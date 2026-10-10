import type { ApplicationDetail, FileRef, SubmissionRecord } from "@bs-job-agents/shared";
import { applicationFixture, submissionRecordFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import {
  applicationsHeader,
  approvalLine,
  cvLabel,
  exportFileName,
  fieldSourceLabel,
  fieldValueText,
  jdSnapshotNote,
  recordFiles,
  recordKicker,
  sortApplications,
  sourceLabel,
  statusChoices,
  type ApplicationRow,
} from "./logic";

const app = applicationFixture;

describe("statusChoices: the manual row of the shared status machine (UC-11 c, UC-13, PM M3)", () => {
  it("lets Ba move freely between post-submit statuses", () => {
    expect(statusChoices({ status: "submitted", dryRun: false })).toEqual(["submitted", "interviewing", "offer", "rejected", "withdrawn", "no_response"]);
    expect(statusChoices({ status: "offer", dryRun: false })).toEqual(["submitted", "interviewing", "offer", "rejected", "withdrawn", "no_response"]);
  });

  it("settles needs_check as submitted or failed, but a dry run never becomes submitted", () => {
    expect(statusChoices({ status: "needs_check", dryRun: false })).toEqual(["submitted", "needs_check", "failed"]);
    expect(statusChoices({ status: "needs_check", dryRun: true })).toEqual(["needs_check", "failed"]);
  });

  it("is read-only while Apply works and after a failure", () => {
    expect(statusChoices({ status: "approved", dryRun: false })).toBeNull();
    expect(statusChoices({ status: "paused", dryRun: false })).toBeNull();
    expect(statusChoices({ status: "failed", dryRun: false })).toBeNull();
  });
});

describe("labels", () => {
  it("names job sources", () => {
    expect(sourceLabel("topcv")).toBe("TopCV");
    expect(sourceLabel("itviec")).toBe("ITviec");
    expect(sourceLabel("linkedin")).toBe("LinkedIn");
    expect(sourceLabel("career_site")).toBe("Career site");
    expect(sourceLabel("acme_board")).toBe("Acme board");
  });

  it("shows where each field value came from, incl. blank optional fields (prototype sourceLabel)", () => {
    expect(fieldSourceLabel("ba_answer")).toBe("your answer");
    expect(fieldSourceLabel("skipped")).toBe("left blank — optional");
    expect(fieldValueText({ label: "Expected salary", name: null, value: null, source: "skipped" })).toBe("— left blank (optional)");
    expect(fieldValueText({ label: "Email", name: null, value: "a@b.c", source: "master_cv" })).toBe("a@b.c");
  });

  it("labels the record kind", () => {
    expect(recordKicker({ origin: "app", dryRun: false })).toBe("Submission record");
    expect(recordKicker({ origin: "imported", dryRun: false })).toBe("Submission record · imported, partial");
    expect(recordKicker({ origin: "app", dryRun: true })).toBe("Submission record · dry run, nothing was sent");
  });

  it("describes the JD snapshot or why it is missing", () => {
    expect(jdSnapshotNote(submissionRecordFixture, "app")).toBe("frozen 2026-10-10 15:39 — survives the post being edited or deleted");
    expect(jdSnapshotNote({ ...submissionRecordFixture, jdSnapshot: null }, "imported")).toBe("not captured (applied before this app)");
    expect(jdSnapshotNote(null, "app")).toBe("not captured");
  });

  it("shows the approval's time, CV version and sites, never the token (PM S25)", () => {
    const line = approvalLine(submissionRecordFixture.approval!, "NOVAPAY_SENIOR-FRONTEND_EN_v1");
    expect(line).toBe(
      "2026-10-10 15:36 · token for BA_HUYNH_NovaPay_EN_v1.pdf on itviec.com (single use) · CV version NOVAPAY_SENIOR-FRONTEND_EN_v1 · allowed sites: itviec.com",
    );
    expect(line).not.toContain(submissionRecordFixture.approvalToken!);
  });

  it("summarises the list in the header (UC-13b: data folder and last export)", () => {
    expect(applicationsHeader(6, null)).toBe("6 applications · stored on this Mac in data/ · click a row to see exactly what was sent");
    expect(applicationsHeader(1, "2026-10-11T09:05:00+07:00")).toBe(
      "1 application · stored on this Mac in data/ · click a row to see exactly what was sent · last export 2026-10-11 09:05",
    );
  });

  it("names the export file after its path", () => {
    expect(exportFileName({ id: "e", createdAt: "2026-10-11T09:05:00+07:00", path: "data/exports/job-agents-export_2026-10-11.zip", applicationCount: 3 })).toBe(
      "job-agents-export_2026-10-11.zip",
    );
  });
});

const ref = (id: string, kind: FileRef["kind"], filename: string, mime = "image/png"): FileRef => ({ id, kind, filename, mime });

describe("recordFiles: which file is which in the record panel", () => {
  const detail = (submission: SubmissionRecord | null, files: FileRef[]): ApplicationDetail => ({
    application: app,
    job: { id: "job_1", title: "T", company: "NovaPay", url: null, source: "itviec" },
    cvVersion: null,
    submission,
    files,
  });

  it("matches screenshots by the record's file names", () => {
    const files = [
      ref("f_cv", "cv_pdf", "BA_HUYNH_NovaPay_EN_v1.pdf", "application/pdf"),
      ref("f_conf", "screenshot", "confirmation.png"),
      ref("f_pre", "screenshot", "pre-submit.png"),
      ref("f_jdpng", "jd_screenshot", "jd.png"),
      ref("f_jd", "jd_snapshot", "jd.txt", "text/plain"),
    ];
    const r = recordFiles(detail(submissionRecordFixture, files));
    expect(r.cv?.id).toBe("f_cv");
    expect(r.preSubmit?.id).toBe("f_pre");
    expect(r.confirmation?.id).toBe("f_conf");
    expect(r.jdScreenshot?.id).toBe("f_jdpng");
    expect(r.jdText?.id).toBe("f_jd");
  });

  it("reports missing proof as null (shown as “not captured”)", () => {
    const r = recordFiles(detail({ ...submissionRecordFixture, preSubmitScreenshotPath: null, confirmationScreenshotPath: null }, [ref("f_pre", "screenshot", "pre-submit.png")]));
    expect(r.preSubmit).toBeNull();
    expect(r.confirmation).toBeNull();
    expect(r.cv).toBeNull();
  });
});

const row = (over: Partial<ApplicationRow> & { id: string; at: string | null; history?: string }): ApplicationRow => ({
  application: { ...app, id: over.id, submittedAt: over.at, statusHistory: [{ status: "approved", at: over.history ?? "2026-10-01T00:00:00+07:00", note: null }] },
  job: { id: "j", title: "T", company: over.id, url: null, source: "topcv" },
  cvVersion: null,
  confirmationScreenshotFileId: null,
  partialRecord: false,
  cvFile: null,
});

describe("rows", () => {
  it("sorts newest first, using the last status change when nothing was submitted", () => {
    const rows = [row({ id: "a", at: "2026-10-10T15:38:00+07:00" }), row({ id: "b", at: null, history: "2026-10-11T08:00:00+07:00" }), row({ id: "c", at: "2026-10-10T15:44:00+07:00" })];
    expect(sortApplications(rows).map((r) => r.application.id)).toEqual(["b", "c", "a"]);
  });

  it("labels the CV column with the version, or the file sent for imported applications", () => {
    expect(cvLabel({ cvVersion: { id: "v", label: "NOVAPAY_FE_EN_v1", language: "en", pdfFileId: "f", figmaFrameUrl: null }, cvFile: null })).toBe("NOVAPAY_FE_EN_v1.pdf");
    expect(cvLabel({ cvVersion: null, cvFile: ref("f", "cv_pdf", "BA_HUYNH_DEKON_Figma_EN.pdf", "application/pdf") })).toBe("BA_HUYNH_DEKON_Figma_EN.pdf");
    expect(cvLabel({ cvVersion: null, cvFile: null })).toBe("not captured");
  });
});
