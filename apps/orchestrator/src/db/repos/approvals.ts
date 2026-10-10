import { randomBytes } from "node:crypto";
import { LIMITS, PRE_SUBMIT_APPLICATION_STATUSES, isApplyBlockedByInjection } from "@bs-job-agents/shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Conn } from "../client.js";
import { ApprovalRefusedError, InvalidTransitionError, NotFoundError } from "../errors.js";
import { applications, approvals, jobSnapshots, jobs, submissions } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { Application, Approval } from "../types.js";

export const APPROVAL_TTL_MS = LIMITS.approvalTokenTtlMs;

/** UC-07 b, §10.2 rule 4: is Apply blocked for this job until Ba confirms a suspected injection? */
function injectionBlocked(db: Conn, jobId: number): boolean {
  const job = db
    .select({ injectionFlagged: jobs.injectionFlagged, injectionClearedAt: jobs.injectionClearedAt })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .get();
  return job !== undefined && isApplyBlockedByInjection(job);
}

function getApplicationRow(db: Conn, id: number): Application | undefined {
  return db.select().from(applications).where(eq(applications.id, id)).get();
}

/**
 * PM M2: Apply may start or resume for an application only while it is approved or paused
 * and nothing has been recorded for it.
 */
function applicationState(db: Conn, app: Application): "open" | "application_recorded" | "application_closed" {
  const recorded =
    db.select({ id: submissions.applicationId }).from(submissions).where(eq(submissions.applicationId, app.id)).get() ??
    db.select({ id: jobSnapshots.applicationId }).from(jobSnapshots).where(eq(jobSnapshots.applicationId, app.id)).get();
  if (recorded) return "application_recorded";
  if (!(PRE_SUBMIT_APPLICATION_STATUSES as readonly string[]).includes(app.status)) return "application_closed";
  return "open";
}

export interface CreateApprovalInput {
  /**
   * The one application this token authorises (PM M2). UC-08 creates both in one transaction
   * (`approveApplication`); after expiry Ba approves again, which issues a new token for it.
   */
  applicationId: number;
  jobId: number;
  cvVersionId: number;
  allowedDomains: string[];
  ttlMs?: number;
}

/**
 * UC-08 step 1: a single-use token bound to application + job + CV version + domains, valid
 * 24 h. Refused while the job is injection-flagged and Ba has not confirmed it (UC-07 b;
 * InvalidTransitionError), and with ApprovalRefusedError when the application is for another
 * job or CV version, has a record, left the apply flow, or still has an unexpired token.
 */
export function createApproval(db: Conn, input: CreateApprovalInput, opts?: ClockOpts): Approval {
  if (injectionBlocked(db, input.jobId)) {
    throw new InvalidTransitionError("job", "injection flagged (not confirmed)", "approved");
  }
  const now = opts?.now ?? new Date();
  return db.transaction((tx) => {
    const app = getApplicationRow(tx, input.applicationId);
    if (!app) throw new NotFoundError("application", input.applicationId);
    if (app.jobId !== input.jobId || app.cvVersionId !== input.cvVersionId) {
      throw new ApprovalRefusedError(
        "application_mismatch",
        `application ${app.id} is for job ${app.jobId} and CV version ${app.cvVersionId}`,
      );
    }
    const state = applicationState(tx, app);
    if (state !== "open") throw new ApprovalRefusedError(state, `application ${app.id} is ${app.status}`);
    const live = tx
      .select({ token: approvals.token })
      .from(approvals)
      .where(and(eq(approvals.applicationId, app.id), gt(approvals.expiresAt, now.toISOString())))
      .get();
    if (live) throw new ApprovalRefusedError("token_live", `application ${app.id} already has an unexpired token`);
    return tx
      .insert(approvals)
      .values({
        token: randomBytes(32).toString("hex"),
        applicationId: app.id,
        jobId: input.jobId,
        cvVersionId: input.cvVersionId,
        allowedDomains: input.allowedDomains.map(normalizeDomain),
        expiresAt: new Date(now.getTime() + (input.ttlMs ?? APPROVAL_TTL_MS)).toISOString(),
        createdAt: now.toISOString(),
      })
      .returning()
      .get();
  });
}

export function getApproval(db: Conn, token: string): Approval | undefined {
  return db.select().from(approvals).where(eq(approvals.token, token)).get();
}

export type ApprovalDenial =
  | "not_found"
  /** First spawn: the token was already used (UC-11 f). */
  | "used"
  /** Resume: the token was never used; the first spawn consumes it (consumeApproval). */
  | "not_used"
  | "expired"
  /** PM M2: the token was issued for another application (e.g. a dry run's token), or for none. */
  | "application_mismatch"
  | "job_mismatch"
  | "cv_mismatch"
  | "domain_mismatch"
  | "injection_flagged"
  /** PM M2: the application already has a submission record. */
  | "application_recorded"
  /** PM M2: the application is no longer approved or paused (needs_check, failed, submitted, …). */
  | "application_closed";
export type ApprovalCheck = { ok: true; approval: Approval } | { ok: false; reason: ApprovalDenial };

export interface ApprovalExpectation extends ClockOpts {
  /** The application Apply runs for: the token must have been issued for it (PM M2). */
  applicationId: number;
  jobId: number;
  cvVersionId: number;
  /** Host the action targets; subdomains of an allowed domain match. Always pass it: without it the domain is not checked. */
  domain?: string;
}

/** A resume always names the domain Apply continues on. */
export interface ApprovalResumeExpectation extends ApprovalExpectation {
  domain: string;
}

function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/\.$/, "");
}

export function domainAllowed(allowed: readonly string[], host: string): boolean {
  const h = normalizeDomain(host);
  return allowed.some((d) => h === d || h.endsWith(`.${d}`));
}

const deny = (reason: ApprovalDenial): ApprovalCheck => ({ ok: false, reason });

function evaluate(db: Conn, approval: Approval | undefined, expect: ApprovalExpectation, use: "first" | "resume"): ApprovalCheck {
  if (!approval) return deny("not_found");
  if (use === "first" && approval.usedAt) return deny("used");
  if (use === "resume" && !approval.usedAt) return deny("not_used");
  if (approval.expiresAt <= nowIso(expect)) return deny("expired");
  if (approval.applicationId !== expect.applicationId) return deny("application_mismatch");
  if (approval.jobId !== expect.jobId) return deny("job_mismatch");
  if (approval.cvVersionId !== expect.cvVersionId) return deny("cv_mismatch");
  if (expect.domain !== undefined && !domainAllowed(approval.allowedDomains, expect.domain)) return deny("domain_mismatch");
  if (injectionBlocked(db, approval.jobId)) return deny("injection_flagged");
  const app = getApplicationRow(db, expect.applicationId);
  if (!app || app.jobId !== approval.jobId || app.cvVersionId !== approval.cvVersionId) return deny("application_mismatch");
  const state = applicationState(db, app);
  return state === "open" ? { ok: true, approval } : deny(state);
}

/** Read-only validation for Apply's first spawn (the trust guard's check, §10.2 rules 1 and 4). */
export function checkApproval(db: Conn, token: string, expect: ApprovalExpectation): ApprovalCheck {
  return evaluate(db, getApproval(db, token), expect, "first");
}

/** First spawn: validate and mark the token used, atomically. A second call returns `used`. */
export function consumeApproval(db: Conn, token: string, expect: ApprovalExpectation): ApprovalCheck {
  return db.transaction(
    (tx) => {
      const check = evaluate(tx, getApproval(tx, token), expect, "first");
      if (!check.ok) return check;
      const approval = tx
        .update(approvals)
        .set({ usedAt: nowIso(expect) })
        .where(and(eq(approvals.token, token), isNull(approvals.usedAt)))
        .returning()
        .get();
      return approval ? { ok: true as const, approval } : { ok: false as const, reason: "used" as const };
    },
    { behavior: "immediate" },
  );
}

/**
 * Resume of the same application after a pause (UC-11 a/b/e, UC-12, UC-17; PM M2). The token
 * was consumed at the first spawn; it re-validates only for the application it was issued
 * for, while that application is approved or paused, has no submission record, and the
 * token has not expired (24 h, as at the first spawn). Read-only. After expiry Ba approves
 * again on the card, which issues a new token for the same application; its next spawn
 * is a first spawn (consumeApproval).
 */
export function checkApprovalForResume(db: Conn, token: string, expect: ApprovalResumeExpectation): ApprovalCheck {
  return evaluate(db, getApproval(db, token), expect, "resume");
}

/**
 * UC-11e: Ba confirmed a new domain (e.g. an ATS) for this token. The list only grows, and
 * only while the application is approved or paused and has no record (PM M2).
 */
export function addApprovalDomain(db: Conn, token: string, domain: string): Approval {
  return db.transaction((tx) => {
    const approval = getApproval(tx, token);
    if (!approval) throw new NotFoundError("approval", token);
    const app = approval.applicationId === null ? undefined : getApplicationRow(tx, approval.applicationId);
    if (!app) throw new ApprovalRefusedError("application_mismatch", "the token is not bound to an application");
    const state = applicationState(tx, app);
    if (state !== "open") throw new ApprovalRefusedError(state, `application ${app.id} is ${app.status}`);
    const d = normalizeDomain(domain);
    if (approval.allowedDomains.includes(d)) return approval;
    return tx
      .update(approvals)
      .set({ allowedDomains: [...approval.allowedDomains, d] })
      .where(eq(approvals.token, token))
      .returning()
      .get()!;
  });
}
