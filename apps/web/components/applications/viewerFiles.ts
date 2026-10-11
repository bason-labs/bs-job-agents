// The FileViewer variants the Applications screen opens (spec §11 file viewer rule):
// CV PDF (pdf), screenshots (image), the frozen JD snapshot (text) and the recorded form (form).
import type { ApplicationDetail, FileRef, SubmissionRecord } from "@bs-job-agents/shared";
import type { ViewerFile } from "@/components/ui";
import { formatDateTime } from "@/components/schedules/datetime";
import { fieldValueText } from "./logic";

export type FileUrl = (fileId: string, opts?: { download?: boolean }) => string;

/** "Sao Việt Tech" → "SaoVietTech" (prototype file names). */
export function companySlug(company: string): string {
  return company
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .replace(/[^A-Za-z0-9]/g, "");
}

const fromRef = (ref: FileRef, url: FileUrl) => ({ url: url(ref.id), downloadUrl: url(ref.id, { download: true }) });

export function cvViewerFile(ref: FileRef, url: FileUrl, figmaUrl?: string | null): ViewerFile {
  return { name: ref.filename, kind: "pdf", ...fromRef(ref, url), figmaUrl: figmaUrl ?? undefined };
}

export function screenshotViewerFile(ref: FileRef, url: FileUrl, company: string, subtitle: string): ViewerFile {
  return { name: `${companySlug(company)}_${ref.filename}`, kind: "image", subtitle, ...fromRef(ref, url) };
}

/** The frozen JD text; Download saves the stored file, or the text itself when there is none. */
export function jdViewerFile(snapshot: NonNullable<SubmissionRecord["jdSnapshot"]>, ref: FileRef | null, url: FileUrl): ViewerFile {
  return {
    name: `${companySlug(snapshot.company)}_JD_snapshot.txt`,
    kind: "text",
    text: snapshot.jdText,
    subtitle: `Frozen JD snapshot · captured ${formatDateTime(snapshot.capturedAt)}`,
    downloadUrl: ref ? url(ref.id, { download: true }) : undefined,
  };
}

/** The form as recorded: every field Apply filled, and the consent it ticked. */
export function formViewerFile(detail: Pick<ApplicationDetail, "job">, record: SubmissionRecord): ViewerFile {
  return {
    name: `${companySlug(detail.job.company)}_form_fields`,
    kind: "form",
    subtitle: "recorded form fields",
    formHeader: "Form as recorded — the values Apply filled in",
    fields: record.fields.map((f) => ({ label: f.label, value: fieldValueText(f) })),
    consentText: record.consent?.ticked ? (record.consent.text ?? undefined) : undefined,
  };
}
