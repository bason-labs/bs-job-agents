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

/** Nothing has been sent yet: Apply is queued, running or paused (UC-08, UC-11). */
export const PRE_SUBMIT_APPLICATION_STATUSES = ["approved", "paused"] as const satisfies readonly ApplicationStatus[];
/** After a submission Ba tracks these by hand (UC-13) and may move freely between them. */
export const POST_SUBMIT_APPLICATION_STATUSES = [
  "submitted",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
  "no_response",
] as const satisfies readonly ApplicationStatus[];

const isPostSubmit = (s: ApplicationStatus): boolean => (POST_SUBMIT_APPLICATION_STATUSES as readonly ApplicationStatus[]).includes(s);

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
    /**
     * Dry-run acceptance (§12): Apply fills the form and never clicks submit. A dry run never
     * counts toward the one-application-per-job rule and never reaches `submitted` (PM M3).
     */
    dryRun: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.origin === "app" && v.cvVersionId === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cvVersionId"], message: "an app application has a CV version" });
    }
    if (v.dryRun && isPostSubmit(v.status)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "a dry run is never submitted" });
    }
  });
export type Application = z.infer<typeof ApplicationSchema>;

/**
 * Who changes an application's status. One machine for the whole app (PM M3):
 * - `system`: the orchestrator while Apply runs (UC-11 a–e, UC-17, UC-18);
 * - `record`: writing the frozen submission record (§9.1, UC-11 step 9);
 * - `manual`: Ba (UC-11 c, UC-13).
 */
export const APPLICATION_STATUS_CHANGES = ["system", "record", "manual"] as const;
export type ApplicationStatusChange = (typeof APPLICATION_STATUS_CHANGES)[number];

type TransitionTable = Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>>;
const NONE: readonly ApplicationStatus[] = [];
const otherPostSubmit = (s: ApplicationStatus): readonly ApplicationStatus[] =>
  POST_SUBMIT_APPLICATION_STATUSES.filter((x) => x !== s);

/**
 * The application status machine. `submitted` is entered from the apply flow only by the
 * submission record, or by Ba settling a `needs_check` (UC-11 c); never by the orchestrator
 * alone (PM probe 6). Between post-submit statuses Ba moves freely, as in the prototype's
 * status select; the history keeps every change, so a mis-click on "Rejected" can be undone.
 */
export const APPLICATION_STATUS_TRANSITIONS: Readonly<Record<ApplicationStatusChange, TransitionTable>> = {
  system: {
    approved: ["paused", "needs_check", "failed"],
    paused: ["approved", "needs_check", "failed"],
    needs_check: NONE,
    failed: NONE,
    submitted: NONE,
    interviewing: NONE,
    offer: NONE,
    rejected: NONE,
    withdrawn: NONE,
    no_response: NONE,
  },
  record: {
    approved: ["submitted", "needs_check"],
    paused: ["submitted", "needs_check"],
    needs_check: NONE,
    failed: NONE,
    submitted: NONE,
    interviewing: NONE,
    offer: NONE,
    rejected: NONE,
    withdrawn: NONE,
    no_response: NONE,
  },
  manual: {
    approved: NONE,
    paused: NONE,
    needs_check: ["submitted", "failed"],
    failed: NONE,
    submitted: otherPostSubmit("submitted"),
    interviewing: otherPostSubmit("interviewing"),
    offer: otherPostSubmit("offer"),
    rejected: otherPostSubmit("rejected"),
    withdrawn: otherPostSubmit("withdrawn"),
    no_response: otherPostSubmit("no_response"),
  },
};

/** Whether `change` may move an application from `from` to `to`. A dry run never reaches a post-submit status. */
export function canTransitionApplicationStatus(
  from: ApplicationStatus,
  to: ApplicationStatus,
  change: ApplicationStatusChange,
  opts: { dryRun?: boolean } = {},
): boolean {
  if (opts.dryRun && isPostSubmit(to)) return false;
  return APPLICATION_STATUS_TRANSITIONS[change][from].includes(to);
}

/** Status changes Ba may make by hand (UC-11 c, UC-13): the `manual` row of the machine. */
export const MANUAL_STATUS_TRANSITIONS: TransitionTable = APPLICATION_STATUS_TRANSITIONS.manual;

/** Ba's manual change (the Applications status select and its API). Pass `dryRun` for a dry-run application. */
export function canChangeApplicationStatus(
  from: ApplicationStatus,
  to: ApplicationStatus,
  opts: { dryRun?: boolean } = {},
): boolean {
  return canTransitionApplicationStatus(from, to, "manual", opts);
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

/**
 * Why the orchestrator refused to write a submission record (§9.1, §10.2 rule 1). The record
 * is Ba's evidence, so it is never written with a token, a file or a dry-run flag that does
 * not match the approval; nothing is written, and the application goes to `needs_check`.
 * - token_missing: no token, or an unknown one (PM M1)
 * - token_unused: the token was never consumed by Apply's first spawn (PM M1)
 * - token_mismatch: the token was issued for another application, job or CV version (PM M1, M2)
 * - sha_mismatch: the uploaded file is not the approved PDF (required for `submitted`) (PM M1)
 * - dry_run_mismatch: the dry-run flag differs from the application's (PM M3)
 */
export const SUBMISSION_REFUSAL_REASONS = [
  "dry_run_mismatch",
  "token_missing",
  "token_unused",
  "token_mismatch",
  "sha_mismatch",
] as const;
export const SubmissionRefusalReasonSchema = z.enum(SUBMISSION_REFUSAL_REASONS);
export type SubmissionRefusalReason = z.infer<typeof SubmissionRefusalReasonSchema>;
