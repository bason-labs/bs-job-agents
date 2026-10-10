import { and, desc, eq, inArray } from "drizzle-orm";
import type { Conn } from "../client.js";
import type { ApplicationOrigin, ApplicationStatus } from "../enums.js";
import { ImmutableRecordError, InvalidTransitionError, NotFoundError } from "../errors.js";
import { applications, jobs, jobSnapshots, submissions, type StatusHistoryEntry } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { Application, Approval, Company, CvVersion, Job, JobSnapshot, Submission } from "../types.js";
import { getApproval } from "./approvals.js";
import { getCompany } from "./companies.js";
import { getCvVersion } from "./cv.js";
import { getJob } from "./jobs.js";

// ---------------------------------------------------------------- status machine

const POST_SUBMIT: readonly ApplicationStatus[] = [
  "submitted",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
  "no_response",
];

const PRE_SUBMIT_TRANSITIONS: Partial<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  approved: ["paused", "submitted", "needs_check", "failed"],
  paused: ["approved", "submitted", "needs_check", "failed"],
  // UC-11c: never resubmitted automatically; Ba marks it submitted or failed.
  needs_check: ["submitted", "failed"],
  failed: [],
};

/**
 * Allowed application status changes. Submit flow: approved ⇄ paused →
 * submitted | needs_check | failed; needs_check → submitted | failed. After
 * submit, Ba tracks the status manually (UC-13) and may move freely between
 * submitted / interviewing / offer / rejected / withdrawn / no_response.
 */
export function canTransitionApplication(from: ApplicationStatus, to: ApplicationStatus): boolean {
  if (from === to) return false;
  if (POST_SUBMIT.includes(from)) return POST_SUBMIT.includes(to);
  return PRE_SUBMIT_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------- reads

export function getApplication(db: Conn, id: number): Application | undefined {
  return db.select().from(applications).where(eq(applications.id, id)).get();
}

/** The application for a job (the newest one if it was re-applied). */
export function getApplicationByJob(db: Conn, jobId: number): Application | undefined {
  return db
    .select()
    .from(applications)
    .where(eq(applications.jobId, jobId))
    .orderBy(desc(applications.id))
    .limit(1)
    .get();
}

export function listApplications(
  db: Conn,
  filter: { status?: ApplicationStatus | readonly ApplicationStatus[]; origin?: ApplicationOrigin } = {},
): Application[] {
  const statuses = filter.status === undefined ? undefined : ([] as ApplicationStatus[]).concat(filter.status);
  return db
    .select()
    .from(applications)
    .where(
      and(
        statuses ? inArray(applications.status, statuses) : undefined,
        filter.origin ? eq(applications.origin, filter.origin) : undefined,
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
 */
export function createApplication(
  db: Conn,
  input: { jobId: number; cvVersionId: number; reapply?: boolean },
  opts?: ClockOpts,
): Application {
  return db.transaction((tx) => {
    const now = nowIso(opts);
    const app = tx
      .insert(applications)
      .values({
        jobId: input.jobId,
        cvVersionId: input.cvVersionId,
        status: "approved",
        origin: "app",
        reapply: input.reapply ?? false,
        statusHistory: [{ status: "approved", at: now }],
        createdAt: now,
      })
      .returning()
      .get();
    markJob(tx, input.jobId, "approved");
    return app;
  });
}

/** Change status and append it to `status_history_json` (UC-13). Same status is a no-op. */
export function transitionApplication(
  db: Conn,
  id: number,
  to: ApplicationStatus,
  opts: ClockOpts & { note?: string } = {},
): Application {
  return db.transaction((tx) => {
    const app = mustGet(tx, id);
    if (app.status === to) return app;
    if (!canTransitionApplication(app.status, to)) throw new InvalidTransitionError("application", app.status, to);
    const entry: StatusHistoryEntry = { status: to, at: nowIso(opts), ...(opts.note ? { note: opts.note } : {}) };
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

export type SubmissionInput = Omit<typeof submissions.$inferInsert, "applicationId">;
export type SnapshotInput = Omit<typeof jobSnapshots.$inferInsert, "applicationId" | "capturedAt"> & {
  capturedAt?: string;
};

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
 * §9.1 / UC-11 step 9: write the frozen submission record — application status
 * + `submissions` + `job_snapshots` — in one transaction. Throws (and writes
 * nothing) on any failure; the caller then marks the application `needs_check`
 * and keeps the raw ApplyResult in the task output.
 */
export function recordSubmission(
  db: Conn,
  input: {
    applicationId: number;
    status?: Extract<ApplicationStatus, "submitted" | "needs_check">;
    submission: SubmissionInput;
    snapshot: SnapshotInput;
  },
  opts?: ClockOpts,
): SubmissionRecord {
  return db.transaction((tx) => {
    const now = nowIso(opts);
    const app = mustGet(tx, input.applicationId);
    assertNoRecord(tx, app.id);
    const status = input.status ?? "submitted";
    if (app.status !== status && !canTransitionApplication(app.status, status)) {
      throw new InvalidTransitionError("application", app.status, status);
    }
    const submittedAt = input.submission.submittedAt ?? now;
    const history =
      app.status === status ? app.statusHistory : [...app.statusHistory, { status, at: submittedAt }];
    const application = tx
      .update(applications)
      .set({ status, submittedAt, statusHistory: history })
      .where(eq(applications.id, app.id))
      .returning()
      .get()!;
    const submission = tx
      .insert(submissions)
      .values({ ...input.submission, applicationId: app.id, submittedAt })
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
