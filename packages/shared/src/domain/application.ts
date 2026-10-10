// Applications and the frozen submission record (§9, §9.1, UC-11, UC-13).
import { z } from "zod";
import { DomainSchema, IdSchema, IsoDateTimeSchema, Sha256Schema, UrlSchema } from "../common/primitives.js";
import { FieldSourceSchema } from "../bots/apply.js";

/**
 * approved → (Apply runs) → submitted | needs_check | paused | failed;
 * then manual (UC-13): submitted → interviewing → offer | rejected | withdrawn | no_response.
 */
// Order matches the applications_status_check CHECK in the DB (a reorder would make
// drizzle-kit rebuild the table and drop its immutability triggers).
export const APPLICATION_STATUSES = [
  "approved",
  "paused",
  "submitted",
  "needs_check",
  "failed",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
  "no_response",
] as const;
export const ApplicationStatusSchema = z.enum(APPLICATION_STATUSES);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

export const ApplicationOriginSchema = z.enum(["app", "imported"]);
export type ApplicationOrigin = z.infer<typeof ApplicationOriginSchema>;

export const StatusHistoryEntrySchema = z.object({
  status: ApplicationStatusSchema,
  at: IsoDateTimeSchema,
  note: z.string().nullable(),
});
export type StatusHistoryEntry = z.infer<typeof StatusHistoryEntrySchema>;

export const ApplicationSchema = z
  .object({
    id: IdSchema,
    jobId: IdSchema,
    /** Null only for imported applications made before this app. */
    cvVersionId: IdSchema.nullable(),
    submittedAt: IsoDateTimeSchema.nullable(),
    status: ApplicationStatusSchema,
    origin: ApplicationOriginSchema,
    statusHistory: z.array(StatusHistoryEntrySchema),
  })
  .superRefine((v, ctx) => {
    if (v.origin === "app" && v.cvVersionId === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cvVersionId"], message: "an app application has a CV version" });
    }
  });
export type Application = z.infer<typeof ApplicationSchema>;

/** Status changes Ba may make by hand (UC-11 c, UC-13). */
export const MANUAL_STATUS_TRANSITIONS: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  approved: [],
  paused: [],
  needs_check: ["submitted", "failed"],
  submitted: ["interviewing", "offer", "rejected", "withdrawn", "no_response"],
  interviewing: ["offer", "rejected", "withdrawn", "no_response"],
  no_response: ["interviewing", "offer", "rejected", "withdrawn"],
  offer: ["withdrawn"],
  rejected: [],
  withdrawn: [],
  failed: [],
};

export function canChangeApplicationStatus(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return MANUAL_STATUS_TRANSITIONS[from].includes(to);
}

/** Records are immutable; only status changes, appended to history (§9.1). */
export function appendStatus<A extends Pick<Application, "status" | "statusHistory">>(
  app: A,
  status: ApplicationStatus,
  at: string,
  note: string | null = null,
): A {
  return { ...app, status, statusHistory: [...app.statusHistory, { status, at, note }] };
}

/** `job_snapshots`: the posting frozen at submit time (UC-11 step 5). */
export const JobSnapshotSchema = z.object({
  applicationId: IdSchema,
  capturedAt: IsoDateTimeSchema,
  url: UrlSchema,
  title: z.string().min(1),
  company: z.string().min(1),
  salaryText: z.string().nullable(),
  jdText: z.string().min(1),
  pageScreenshotPath: z.string().nullable(),
});
export type JobSnapshot = z.infer<typeof JobSnapshotSchema>;

export const SubmittedFieldSchema = z.object({
  label: z.string().min(1),
  name: z.string().nullable(),
  /** null = left blank — optional (source skipped). */
  value: z.string().nullable(),
  source: FieldSourceSchema,
});
export type SubmittedField = z.infer<typeof SubmittedFieldSchema>;

/**
 * Submission record (§9.1): `submissions` + `job_snapshots` (+ approval), written in one
 * transaction after submit and never edited. Imported applications may miss parts
 * (null = "not captured", UC-13).
 */
export const SubmissionRecordSchema = z.object({
  applicationId: IdSchema,
  finalUrl: UrlSchema.nullable(),
  fields: z.array(SubmittedFieldSchema),
  introText: z.string().nullable(),
  consent: z.object({ ticked: z.boolean(), text: z.string().nullable() }).nullable(),
  uploadedFile: z
    .object({
      filename: z.string().min(1),
      /** Computed before upload and checked against the approved CV version (§9.1). */
      sha256: Sha256Schema.nullable(),
      /** Copy under data/applications/<applicationId>/. */
      path: z.string().nullable(),
    })
    .nullable(),
  preSubmitScreenshotPath: z.string().nullable(),
  confirmationScreenshotPath: z.string().nullable(),
  confirmationText: z.string().nullable(),
  approvalToken: z.string().nullable(),
  /** Approval shown in the record panel: time, CV version, allowed sites. */
  approval: z
    .object({
      approvedAt: IsoDateTimeSchema,
      cvVersionId: IdSchema.nullable(),
      allowedDomains: z.array(DomainSchema),
      note: z.string().nullable(),
    })
    .nullable(),
  submittedAt: IsoDateTimeSchema.nullable(),
  jdSnapshot: JobSnapshotSchema.nullable(),
  /**
   * Dry-run acceptance (§12): Apply filled the form and took the screenshots but never
   * clicked submit. The application is recorded as `needs_check` (DRY_RUN_APPLICATION_STATUS).
   */
  dryRun: z.boolean(),
});
export type SubmissionRecord = z.infer<typeof SubmissionRecordSchema>;

/** Status a dry-run Apply leaves its application in (coordinator decision, Phase 1 QA). */
export const DRY_RUN_APPLICATION_STATUS = "needs_check" as const satisfies ApplicationStatus;
