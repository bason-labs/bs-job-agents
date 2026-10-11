// Applications screen and the submission record panel (UC-13, §9.1). The record is shown as it was
// frozen, with three API rules on top (S18): the approval token is never shown (only the approval's
// time, CV version and sites), a stored path that leaves data/ is shown as "not captured" (null),
// and files are offered by id only when they resolve inside data/ with the right type.
import {
  POST_SUBMIT_APPLICATION_STATUSES,
  SubmissionRecordSchema,
  type ApplicationDetail,
  type ApplicationListItem,
  type ApprovalSummary,
  type FileRef,
  type SubmissionRecord,
} from "@bs-job-agents/shared";
import { getCompany, getSubmissionRecord, latestApprovalForApplication, mappers, type Application, type CvVersion, type Db, type FullSubmissionRecord } from "../../db/index.js";
import { fileRef, fileRefs, safeDataPath, type FileId } from "../files.js";

const isPostSubmit = (status: Application["status"]): boolean => (POST_SUBMIT_APPLICATION_STATUSES as readonly string[]).includes(status);

function cvSummary(cv: CvVersion | undefined, pdf: FileRef | null): ApplicationListItem["cvVersion"] {
  if (!cv) return null;
  return {
    id: String(cv.id),
    label: cv.figmaFrameName ?? `CV_${cv.language.toUpperCase()}_v${cv.round}`,
    language: cv.language,
    pdfFileId: pdf?.id ?? null,
    figmaFrameUrl: cv.figmaFrameUrl,
  };
}

function jobSummary(db: Db, rec: FullSubmissionRecord): ApplicationListItem["job"] {
  const company = rec.company ?? getCompany(db, rec.job.companyId);
  return { id: String(rec.job.id), title: rec.job.title, company: company?.name ?? "", url: rec.job.url, source: rec.job.source };
}

/** The record as the panel shows it: no token, no path outside data/. Null when nothing was recorded. */
export function panelRecord(rec: FullSubmissionRecord, warn: (m: string) => void): SubmissionRecord | null {
  const record = mappers.toSubmissionRecord(rec);
  if (!record) return null;
  const safe: SubmissionRecord = {
    ...record,
    approvalToken: null,
    uploadedFile: record.uploadedFile ? { ...record.uploadedFile, path: safeDataPath(record.uploadedFile.path) } : null,
    preSubmitScreenshotPath: safeDataPath(record.preSubmitScreenshotPath),
    confirmationScreenshotPath: safeDataPath(record.confirmationScreenshotPath),
    jdSnapshot: record.jdSnapshot ? { ...record.jdSnapshot, pageScreenshotPath: safeDataPath(record.jdSnapshot.pageScreenshotPath) } : null,
  };
  const parsed = SubmissionRecordSchema.safeParse(safe);
  if (parsed.success) return parsed.data;
  // A frozen snapshot with a bad URL must not hide the rest of the record.
  const withoutSnapshot = SubmissionRecordSchema.safeParse({ ...safe, jdSnapshot: null });
  warn(`application ${rec.application.id}: its record does not fully match the shared schema`);
  return withoutSnapshot.success ? withoutSnapshot.data : null;
}

const appFile = (id: number, part: "cv" | "presubmit" | "confirmation" | "jd" | "jd-screenshot"): FileId => ({ type: "app", id, part });

/** One row of the Applications table. */
export async function applicationListItem(db: Db, dataDir: string, app: Application): Promise<ApplicationListItem | null> {
  const rec = getSubmissionRecord(db, app.id);
  if (!rec) return null;
  const cvPdf = rec.cvVersion ? await fileRef(db, dataDir, { type: "cv", id: rec.cvVersion.id }) : null;
  const uploaded = await fileRef(db, dataDir, appFile(app.id, "cv"));
  const preSubmit = await fileRef(db, dataDir, appFile(app.id, "presubmit"));
  const confirmation = await fileRef(db, dataDir, appFile(app.id, "confirmation"));
  const s = rec.submission;
  // Imported, or a submitted / to-check record missing a part: "not captured" badges (UC-13).
  const missing = !s || !uploaded || !preSubmit || (!confirmation && !s.confirmationText) || !rec.snapshot;
  const partialRecord = app.origin === "imported" || ((isPostSubmit(app.status) || app.status === "needs_check") && missing);
  return {
    application: mappers.toApplication(app),
    job: jobSummary(db, rec),
    cvVersion: cvSummary(rec.cvVersion, cvPdf),
    confirmationScreenshotFileId: confirmation?.id ?? null,
    preSubmitScreenshotFileId: preSubmit?.id ?? null,
    partialRecord,
    cvFile: uploaded ?? cvPdf,
  };
}

/** The submission record panel (UC-13). */
export async function applicationDetail(db: Db, dataDir: string, app: Application, warn: (m: string) => void): Promise<ApplicationDetail | null> {
  const rec = getSubmissionRecord(db, app.id);
  if (!rec) return null;
  const cvPdf = rec.cvVersion ? await fileRef(db, dataDir, { type: "cv", id: rec.cvVersion.id }) : null;
  const files = await fileRefs(db, dataDir, [
    appFile(app.id, "cv"),
    ...(rec.cvVersion ? [{ type: "cv", id: rec.cvVersion.id } as const] : []),
    appFile(app.id, "presubmit"),
    appFile(app.id, "confirmation"),
    appFile(app.id, "jd"),
    appFile(app.id, "jd-screenshot"),
  ]);
  return {
    application: mappers.toApplication(app),
    job: jobSummary(db, rec),
    cvVersion: cvSummary(rec.cvVersion, cvPdf),
    submission: panelRecord(rec, warn),
    files,
    approval: approvalSummary(db, app),
  };
}

/**
 * PM3 S3, UC-13: the latest approval of the application (the record's own approval once one is
 * written), so approved, paused and needs_check applications show it too. Never the token.
 */
function approvalSummary(db: Db, app: Application): ApprovalSummary | null {
  const approval = latestApprovalForApplication(db, app.id);
  if (!approval) return null;
  return {
    approvedAt: approval.createdAt,
    cvVersionId: String(approval.cvVersionId),
    allowedDomains: approval.allowedDomains,
    note: app.dryRun ? "dry run" : null,
  };
}
