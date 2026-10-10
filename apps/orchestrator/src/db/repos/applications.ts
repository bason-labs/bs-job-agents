import {
  DRY_RUN_APPLICATION_STATUS,
  SAFETY_REASON_FOR_SUBMISSION_REFUSAL,
  canTransitionApplicationStatus,
  type ApplicationStatusChange,
} from "@bs-job-agents/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Conn } from "../client.js";
import type { ApplicationOrigin, ApplicationStatus } from "../enums.js";
import { ImmutableRecordError, InvalidTransitionError, NotFoundError, SubmissionRefusedError } from "../errors.js";
import { applications, jobs, jobSnapshots, submissions, type StatusHistoryEntry } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { Application, Approval, Company, CvVersion, EventRow, Job, JobSnapshot, Submission } from "../types.js";
import { createApproval, getApproval, requireCvVersionOfJob } from "./approvals.js";
import { appendAppEvent } from "./events.js";
import { getCompany } from "./companies.js";
import { getCvVersion } from "./cv.js";
import { getJob } from "./jobs.js";

// ---------------------------------------------------------------- status machine
// One machine for the whole app: shared APPLICATION_STATUS_TRANSITIONS (PM M3).
// transitionApplication makes `system` (orchestrator) or `manual` (Ba) changes. Only
// recordSubmission makes `record` changes, the one orchestrator path to `submitted`.

/** Who calls transitionApplication: the orchestrator ("system") or Ba ("manual"). */
export type ApplicationStatusActor = Exclude<ApplicationStatusChange, "record">;

// ---------------------------------------------------------------- reads

export function getApplication(db: Conn, id: number): Application | undefined {
  return db.select().from(applications).where(eq(applications.id, id)).get();
}

/**
 * The application for a job: the newest one if it was re-applied. This is the "already
 * applied" lookup (§10.2 rule 5, UC-14), so dry runs are ignored unless `includeDryRuns`.
 */
export function getApplicationByJob(
  db: Conn,
  jobId: number,
  opts: { includeDryRuns?: boolean } = {},
): Application | undefined {
  return db
    .select()
    .from(applications)
    .where(and(eq(applications.jobId, jobId), opts.includeDryRuns ? undefined : eq(applications.dryRun, false)))
    .orderBy(desc(applications.id))
    .limit(1)
    .get();
}

export function listApplications(
  db: Conn,
  filter: {
    status?: ApplicationStatus | readonly ApplicationStatus[];
    origin?: ApplicationOrigin;
    /** true = dry runs only, false = real applications only (e.g. the export); default both. */
    dryRun?: boolean;
  } = {},
): Application[] {
  const statuses = filter.status === undefined ? undefined : ([] as ApplicationStatus[]).concat(filter.status);
  return db
    .select()
    .from(applications)
    .where(
      and(
        statuses ? inArray(applications.status, statuses) : undefined,
        filter.origin ? eq(applications.origin, filter.origin) : undefined,
        filter.dryRun === undefined ? undefined : eq(applications.dryRun, filter.dryRun),
      ),
    )
    .orderBy(desc(applications.createdAt), desc(applications.id))
    .all();
}

function mustGet(db: Conn, id: number): Application {
  const app = getApplication(db, id);
  if (!app) throw new NotFoundError("application", id);
  return app;
}

function markJob(db: Conn, jobId: number, status: Job["status"]): void {
  db.update(jobs).set({ status }).where(eq(jobs.id, jobId)).run();
}

// ---------------------------------------------------------------- writes

/**
 * UC-08: Ba approved a card → application `approved` (job → `approved`).
 * `reapply` is the explicit "apply again" that lifts the one-per-job rule.
 * `dryRun` (§12 dry-run acceptance) never counts toward that rule and never reaches
 * `submitted` (PM M3); it needs its own approval token like any application.
 */
export function createApplication(
  db: Conn,
  input: { jobId: number; cvVersionId: number; reapply?: boolean; dryRun?: boolean },
  opts?: ClockOpts,
): Application {
  return db.transaction((tx) => {
    // PM M1: the CV version exists and belongs to the job (ApprovalRefusedError otherwise).
    requireCvVersionOfJob(tx, input.jobId, input.cvVersionId);
    const now = nowIso(opts);
    const app = tx
      .insert(applications)
      .values({
        jobId: input.jobId,
        cvVersionId: input.cvVersionId,
        status: "approved",
        origin: "app",
        reapply: input.reapply ?? false,
        dryRun: input.dryRun ?? false,
        statusHistory: [{ status: "approved", at: now, note: null }],
        createdAt: now,
      })
      .returning()
      .get();
    markJob(tx, input.jobId, "approved");
    return app;
  });
}

/**
 * UC-08: Ba approved a card. Creates the `approved` application and the single-use token
 * bound to it in one transaction (PM M2); if either fails, neither exists. The engine adds
 * the apply.submit task in the same transaction:
 * `db.transaction((tx) => { const { application, approval } = approveApplication(tx, …); createTask(tx, …); })`.
 */
export function approveApplication(
  db: Conn,
  input: {
    jobId: number;
    cvVersionId: number;
    allowedDomains: string[];
    reapply?: boolean;
    dryRun?: boolean;
    ttlMs?: number;
  },
  opts?: ClockOpts,
): { application: Application; approval: Approval } {
  return db.transaction((tx) => {
    const application = createApplication(
      tx,
      { jobId: input.jobId, cvVersionId: input.cvVersionId, reapply: input.reapply, dryRun: input.dryRun },
      opts,
    );
    const approval = createApproval(
      tx,
      {
        applicationId: application.id,
        jobId: input.jobId,
        cvVersionId: input.cvVersionId,
        allowedDomains: input.allowedDomains,
        ttlMs: input.ttlMs,
      },
      opts,
    );
    return { application, approval };
  });
}

/**
 * Change status and append it to `status_history_json` (UC-13). Same status is a no-op.
 * `by` follows the shared status machine (PM M3): "system" (default) is the orchestrator
 * while Apply runs (approved ⇄ paused → needs_check | failed); "manual" is Ba (settle a
 * needs_check as submitted or failed; move freely between post-submit statuses). Neither
 * moves approved/paused to submitted: only recordSubmission does. A dry run never reaches
 * a post-submit status.
 */
export function transitionApplication(
  db: Conn,
  id: number,
  to: ApplicationStatus,
  opts: ClockOpts & { note?: string; by?: ApplicationStatusActor } = {},
): Application {
  return db.transaction((tx) => {
    const app = mustGet(tx, id);
    if (app.status === to) return app;
    if (!canTransitionApplicationStatus(app.status, to, opts.by ?? "system", { dryRun: app.dryRun })) {
      throw new InvalidTransitionError(app.dryRun ? "dry-run application" : "application", app.status, to);
    }
    const entry: StatusHistoryEntry = { status: to, at: nowIso(opts), note: opts.note ?? null };
    const row = tx
      .update(applications)
      .set({ status: to, statusHistory: [...app.statusHistory, entry] })
      .where(eq(applications.id, id))
      .returning()
      .get()!;
    if (to === "submitted") markJob(tx, app.jobId, "applied");
    return row;
  });
}

export type SubmissionInput = Omit<typeof submissions.$inferInsert, "applicationId" | "dryRun">;
export type SnapshotInput = Omit<typeof jobSnapshots.$inferInsert, "applicationId" | "capturedAt"> & {
  capturedAt?: string;
};
/** UC-11 step 5: an app submission always freezes the posting's URL, title, company and text. */
export type CompleteSnapshotInput = SnapshotInput & { url: string; title: string; company: string; jdText: string };

export interface SubmissionRecord {
  application: Application;
  submission: Submission;
  snapshot: JobSnapshot;
}

function assertNoRecord(db: Conn, applicationId: number): void {
  const sub = db.select().from(submissions).where(eq(submissions.applicationId, applicationId)).get();
  const snap = db.select().from(jobSnapshots).where(eq(jobSnapshots.applicationId, applicationId)).get();
  if (sub || snap) throw new ImmutableRecordError(`application ${applicationId} already has a submission record`);
}

/**
 * The approved PDF's SHA-256 against the hash of the file Apply uploaded (computed by the
 * orchestrator on the per-application copy, never reported by the bot). Required for
 * `submitted`; for `needs_check` it may be missing (nothing uploaded) but must match.
 */
function uploadedFileMatches(uploaded: string | null, approved: string | null, status: ApplicationStatus): boolean {
  if (uploaded === null) return status !== "submitted";
  return approved !== null && uploaded === approved;
}

/**
 * §9.1 / UC-11 step 9: write the frozen submission record — application status
 * + `submissions` + `job_snapshots` — in one transaction. Throws (and writes
 * nothing) on any failure; the caller then marks the application `needs_check`
 * and keeps the raw ApplyResult in the task output.
 *
 * The record is Ba's evidence, so it must match its approval (PM M1, M2). It is refused
 * with SubmissionRefusedError (nothing written) unless `submission.approvalToken` names a
 * token that exists (`token_missing`), was consumed by Apply's first spawn (`token_unused`)
 * and was issued for this application, job and CV version (`token_mismatch`), and the
 * uploaded file's SHA-256 equals the approved `cv_versions.pdf_sha256` (`sha_mismatch`;
 * required for `submitted`, checked whenever present for `needs_check`). After a refusal
 * the engine calls markSubmissionRefused. A SQL trigger (0005) also refuses a record whose
 * token is not its application's used token or whose dry-run flag differs.
 *
 * `dryRun` (§12 dry-run acceptance: form filled, submit never clicked) records the
 * attempt with `dry_run = 1` and leaves the application `needs_check`; it can never
 * be recorded as `submitted`. It must match the application's own flag, or the record
 * is refused (SubmissionRefusedError `dry_run_mismatch`, PM M3).
 *
 * The record moves the application from approved / paused only (shared `record`
 * transitions): it is the one orchestrator path to `submitted`.
 */
export function recordSubmission(
  db: Conn,
  input: {
    applicationId: number;
    status?: Extract<ApplicationStatus, "submitted" | "needs_check">;
    dryRun?: boolean;
    submission: SubmissionInput;
    snapshot: CompleteSnapshotInput;
  },
  opts?: ClockOpts,
): SubmissionRecord {
  const dryRun = input.dryRun ?? false;
  if (dryRun && input.status === "submitted") {
    throw new InvalidTransitionError("dry-run application", "approved", "submitted");
  }
  return db.transaction((tx) => {
    const now = nowIso(opts);
    const app = mustGet(tx, input.applicationId);
    assertNoRecord(tx, app.id);
    if (dryRun !== app.dryRun) {
      throw new SubmissionRefusedError(
        "dry_run_mismatch",
        app.id,
        `the record says dryRun=${dryRun}, the application says dryRun=${app.dryRun}`,
      );
    }
    const status = dryRun ? DRY_RUN_APPLICATION_STATUS : (input.status ?? "submitted");
    // PM M1: the record cites the token that authorised this application…
    const token = input.submission.approvalToken;
    const approval = token ? getApproval(tx, token) : undefined;
    if (!approval) {
      throw new SubmissionRefusedError("token_missing", app.id, token ? "the approval token does not exist" : "no approval token");
    }
    if (!approval.usedAt) {
      throw new SubmissionRefusedError("token_unused", app.id, "the token was never consumed by Apply's first spawn");
    }
    if (approval.applicationId !== app.id || approval.jobId !== app.jobId || approval.cvVersionId !== app.cvVersionId) {
      throw new SubmissionRefusedError(
        "token_mismatch",
        app.id,
        `the token was issued for application ${approval.applicationId}, job ${approval.jobId}, CV version ${approval.cvVersionId}`,
      );
    }
    // …and the uploaded file is the approved PDF (§9.1).
    const uploaded = input.submission.uploadedSha256 ?? null;
    const approvedSha = getCvVersion(tx, approval.cvVersionId)?.pdfSha256 ?? null;
    if (!uploadedFileMatches(uploaded, approvedSha, status)) {
      throw new SubmissionRefusedError(
        "sha_mismatch",
        app.id,
        uploaded === null ? "the uploaded file's SHA-256 is missing" : `uploaded ${uploaded}, approved ${approvedSha ?? "none"}`,
      );
    }
    if (!canTransitionApplicationStatus(app.status, status, "record", { dryRun })) {
      throw new InvalidTransitionError("application", app.status, status);
    }
    const submittedAt = input.submission.submittedAt ?? now;
    const history: StatusHistoryEntry[] = [
      ...app.statusHistory,
      { status, at: submittedAt, note: dryRun ? "dry run: form filled, not submitted" : null },
    ];
    const application = tx
      .update(applications)
      .set({ status, submittedAt, statusHistory: history })
      .where(eq(applications.id, app.id))
      .returning()
      .get()!;
    const submission = tx
      .insert(submissions)
      .values({ ...input.submission, applicationId: app.id, submittedAt, dryRun })
      .returning()
      .get();
    const snapshot = tx
      .insert(jobSnapshots)
      .values({ ...input.snapshot, applicationId: app.id, capturedAt: input.snapshot.capturedAt ?? now })
      .returning()
      .get();
    if (status === "submitted") markJob(tx, app.jobId, "applied");
    return { application, submission, snapshot };
  });
}

/**
 * PM M1: what the engine does after recordSubmission threw SubmissionRefusedError (which
 * wrote nothing). In one transaction: the application goes to `needs_check` (unless it is
 * there already, or has left the apply flow), and a `safety.denied` event is appended with
 * the shared reason for the refusal. The engine keeps the raw Apply result on the task.
 */
export function markSubmissionRefused(
  db: Conn,
  input: { error: SubmissionRefusedError; taskId: number | null; botName?: string },
  opts?: ClockOpts,
): { application: Application; event: EventRow } {
  return db.transaction((tx) => {
    const app = mustGet(tx, input.error.applicationId);
    const note = `submission record refused: ${input.error.reason}`;
    const application = canTransitionApplicationStatus(app.status, "needs_check", "system", { dryRun: app.dryRun })
      ? transitionApplication(tx, app.id, "needs_check", { ...opts, note })
      : app;
    const event = appendAppEvent(
      tx,
      {
        type: "safety.denied",
        botName: input.botName ?? "apply",
        taskId: input.taskId === null ? null : String(input.taskId),
        action: "apply.record",
        reason: SAFETY_REASON_FOR_SUBMISSION_REFUSAL[input.error.reason],
        detail: input.error.message,
      },
      opts,
    );
    return { application, event };
  });
}

/**
 * UC-13: applications made before this app (e.g. DEKON / SMARTBIT / YAVIET on
 * TopCV) with whatever is known; missing parts stay NULL ("not captured").
 */
export function importApplication(
  db: Conn,
  input: {
    jobId: number;
    cvVersionId?: number | null;
    submittedAt?: string | null;
    status?: ApplicationStatus;
    submission?: Partial<SubmissionInput>;
    snapshot?: SnapshotInput;
  },
  opts?: ClockOpts,
): { application: Application; submission?: Submission; snapshot?: JobSnapshot } {
  return db.transaction((tx) => {
    const now = nowIso(opts);
    const status = input.status ?? "submitted";
    const submittedAt = input.submittedAt ?? null;
    const application = tx
      .insert(applications)
      .values({
        jobId: input.jobId,
        cvVersionId: input.cvVersionId ?? null,
        status,
        origin: "imported",
        submittedAt,
        statusHistory: [{ status, at: submittedAt ?? now, note: "imported" }],
        createdAt: now,
      })
      .returning()
      .get();
    const submission = input.submission
      ? tx
          .insert(submissions)
          .values({
            ...input.submission,
            fields: input.submission.fields ?? [],
            applicationId: application.id,
            submittedAt: input.submission.submittedAt ?? submittedAt,
          })
          .returning()
          .get()
      : undefined;
    const snapshot = input.snapshot
      ? tx
          .insert(jobSnapshots)
          .values({ ...input.snapshot, applicationId: application.id, capturedAt: input.snapshot.capturedAt ?? now })
          .returning()
          .get()
      : undefined;
    markJob(tx, input.jobId, "applied");
    return { application, submission, snapshot };
  });
}

export interface FullSubmissionRecord {
  application: Application;
  job: Job;
  company?: Company;
  cvVersion?: CvVersion;
  submission?: Submission;
  snapshot?: JobSnapshot;
  approval?: Approval;
}

/** Everything the Submission record panel (UC-13) and the export (UC-13b) show. */
export function getSubmissionRecord(db: Conn, applicationId: number): FullSubmissionRecord | undefined {
  const application = getApplication(db, applicationId);
  if (!application) return undefined;
  const job = getJob(db, application.jobId)!;
  const submission = db.select().from(submissions).where(eq(submissions.applicationId, applicationId)).get();
  const snapshot = db.select().from(jobSnapshots).where(eq(jobSnapshots.applicationId, applicationId)).get();
  return {
    application,
    job,
    company: getCompany(db, job.companyId),
    cvVersion: application.cvVersionId ? getCvVersion(db, application.cvVersionId) : undefined,
    submission,
    snapshot,
    approval: submission?.approvalToken ? getApproval(db, submission.approvalToken) : undefined,
  };
}

// ---------------------------------------------------------------- immutability (§9.1)
// The submission record is never edited or deleted. These exist so callers get
// an explicit error from the repository API; SQLite triggers enforce the same.

export function updateSubmission(..._args: unknown[]): never {
  throw new ImmutableRecordError("submissions are immutable (spec §9.1)");
}

export function deleteSubmission(..._args: unknown[]): never {
  throw new ImmutableRecordError("submissions are immutable (spec §9.1)");
}

export function updateJobSnapshot(..._args: unknown[]): never {
  throw new ImmutableRecordError("job snapshots are immutable (spec §9.1)");
}

export function deleteJobSnapshot(..._args: unknown[]): never {
  throw new ImmutableRecordError("job snapshots are immutable (spec §9.1)");
}
