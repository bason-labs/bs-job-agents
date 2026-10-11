// Applications screen logic (UC-13, UC-13b, §9.1). Pure: the table, the record panel and the
// tests share it.
import {
  FIELD_SOURCE_LABELS,
  canChangeApplicationStatus,
  type Application,
  type ApplicationDetail,
  type ApplicationListItem,
  type ApplicationStatus,
  type Export,
  type FieldSource,
  type FileRef,
  type SubmissionRecord,
  type SubmittedField,
} from "@bs-job-agents/shared";
import { formatDateTime } from "@/components/schedules/datetime";

/**
 * A row of the Applications table. `cvFile` is the PDF that was sent: imported applications
 * have no CV version, so the table shows the file instead (additive API field, see data.ts).
 */
export type ApplicationRow = ApplicationListItem & { cvFile?: FileRef | null };

/** Display order of the status select. */
const STATUS_ORDER: readonly ApplicationStatus[] = [
  "submitted",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
  "no_response",
  "needs_check",
  "failed",
  "approved",
  "paused",
];

/**
 * The statuses Ba can pick in the row's select: the current one plus the manual moves the
 * shared status machine allows. Null = nothing to pick (shown as a read-only pill).
 */
export function statusChoices(app: Pick<Application, "status" | "dryRun">): ApplicationStatus[] | null {
  const allowed = STATUS_ORDER.filter((to) => to !== app.status && canChangeApplicationStatus(app.status, to, { dryRun: app.dryRun }));
  if (allowed.length === 0) return null;
  return STATUS_ORDER.filter((s) => s === app.status || allowed.includes(s));
}

const SOURCE_LABELS: Record<string, string> = {
  topcv: "TopCV",
  itviec: "ITviec",
  linkedin: "LinkedIn",
  career_site: "Career site",
  link: "Link",
  file: "File",
};

export function sourceLabel(source: string): string {
  if (SOURCE_LABELS[source]) return SOURCE_LABELS[source];
  const s = source.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function fieldSourceLabel(source: FieldSource): string {
  return FIELD_SOURCE_LABELS[source];
}

/** A field's value; blank optional fields read "— left blank (optional)" (prototype). */
export function fieldValueText(field: SubmittedField): string {
  return field.value ?? "— left blank (optional)";
}

export function recordKicker(app: Pick<Application, "origin" | "dryRun">): string {
  if (app.dryRun) return "Submission record · dry run, nothing was sent";
  return app.origin === "imported" ? "Submission record · imported, partial" : "Submission record";
}

export function jdSnapshotNote(submission: Pick<SubmissionRecord, "jdSnapshot"> | null, origin: Application["origin"]): string {
  const snap = submission?.jdSnapshot;
  if (snap) return `frozen ${formatDateTime(snap.capturedAt)} — survives the post being edited or deleted`;
  return origin === "imported" ? "not captured (applied before this app)" : "not captured";
}

/** Approval time, note, CV version and sites. Never the token itself (PM S18, S25). */
export function approvalLine(approval: NonNullable<SubmissionRecord["approval"]>, cvVersionLabel: string | null): string {
  const parts = [formatDateTime(approval.approvedAt)];
  if (approval.note) parts.push(approval.note);
  if (cvVersionLabel) parts.push(`CV version ${cvVersionLabel}`);
  if (approval.allowedDomains.length) parts.push(`allowed sites: ${approval.allowedDomains.join(", ")}`);
  return parts.join(" · ");
}

/** "6 applications · stored on this Mac in data/ · … · last export 2026-10-11 09:05" (UC-13b). */
export function applicationsHeader(count: number, lastExportAt: string | null, dataDir = "data/"): string {
  const base = `${count} ${count === 1 ? "application" : "applications"} · stored on this Mac in ${dataDir} · click a row to see exactly what was sent`;
  return lastExportAt ? `${base} · last export ${formatDateTime(lastExportAt)}` : base;
}

export function exportFileName(exp: Export): string {
  return exp.path.split(/[\\/]/).pop() || exp.path;
}

export interface RecordFiles {
  cv: FileRef | null;
  preSubmit: FileRef | null;
  confirmation: FileRef | null;
  jdText: FileRef | null;
  jdScreenshot: FileRef | null;
}

/**
 * Which file is which. The API lists only files that resolve inside data/ (so a listed file is a
 * captured one) and names each record part: ids `app-<n>-presubmit` / `-confirmation`, files
 * `pre-submit.<ext>` / `confirmation.<ext>`, whatever the stored path is called. The first
 * `cv_pdf` is the copy that was sent (`app-<n>-cv`); the CV version's PDF may follow it.
 */
export function recordFiles(detail: Pick<ApplicationDetail, "files">): RecordFiles {
  const { files } = detail;
  const part = (kind: FileRef["kind"], name: string) =>
    files.find((f) => f.kind === kind && (f.id.endsWith(`-${name.replace("-", "")}`) || f.filename.startsWith(`${name}.`))) ?? null;
  return {
    cv: files.find((f) => f.kind === "cv_pdf") ?? files.find((f) => f.kind === "upload" && f.mime === "application/pdf") ?? null,
    preSubmit: part("screenshot", "pre-submit"),
    confirmation: part("screenshot", "confirmation"),
    jdText: files.find((f) => f.kind === "jd_snapshot") ?? null,
    jdScreenshot: files.find((f) => f.kind === "jd_screenshot") ?? null,
  };
}

/** Newest first: submitted time, else the last status change. */
export function sortApplications<R extends Pick<ApplicationRow, "application">>(rows: readonly R[]): R[] {
  const when = (r: R) => r.application.submittedAt ?? r.application.statusHistory.at(-1)?.at ?? "";
  return [...rows].sort((a, b) => Date.parse(when(b)) - Date.parse(when(a)));
}

/** The CV column: the CV version's PDF, or the file sent (imported applications). */
export function cvLabel(row: Pick<ApplicationRow, "cvVersion" | "cvFile">): string {
  if (row.cvVersion) return `${row.cvVersion.label}.pdf`;
  return row.cvFile?.filename ?? "not captured";
}
