import { randomBytes } from "node:crypto";
import {
  DomainSchema,
  LIMITS,
  PRE_SUBMIT_APPLICATION_STATUSES,
  Sha256Schema,
  isApplyBlockedByInjection,
  type SafetyDenialReason,
} from "@bs-job-agents/shared";
import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import type { Conn } from "../client.js";
import { ApprovalRefusedError, InvalidTransitionError, NotFoundError } from "../errors.js";
import { applications, approvals, cvVersions, jobSnapshots, jobs, submissions } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { Application, Approval, CvVersion } from "../types.js";

export const APPROVAL_TTL_MS = LIMITS.approvalTokenTtlMs;

/**
 * PM M1: the CV version an application or approval names must exist and belong to its job.
 * Throws ApprovalRefusedError (`cv_not_found`, `cv_job_mismatch`).
 */
export function requireCvVersionOfJob(db: Conn, jobId: number, cvVersionId: number): CvVersion {
  const cv = db.select().from(cvVersions).where(eq(cvVersions.id, cvVersionId)).get();
  if (!cv) throw new ApprovalRefusedError("cv_not_found", `CV version ${cvVersionId} does not exist`);
  if (cv.jobId !== jobId) {
    throw new ApprovalRefusedError("cv_job_mismatch", `CV version ${cv.id} belongs to job ${cv.jobId}, not job ${jobId}`);
  }
  return cv;
}

/** PM M1: at least one domain, each a host name such as topcv.vn; normalised and de-duplicated. */
function validDomains(domains: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of domains) {
    const d = normalizeDomain(raw);
    if (!DomainSchema.safeParse(d).success) {
      throw new ApprovalRefusedError("invalid_domain", `"${raw}" is not a host name such as topcv.vn`);
    }
    if (!out.includes(d)) out.push(d);
  }
  if (out.length === 0) throw new ApprovalRefusedError("no_domain", "an approval names at least one domain");
  return out;
}

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
  /** Lifetime; at most (and by default) 24 h. */
  ttlMs?: number;
}

/**
 * UC-08 step 1: a single-use token bound to application + job + CV version + domains, valid
 * 24 h. Refused while the job is injection-flagged and Ba has not confirmed it (UC-07 b;
 * InvalidTransitionError). Refused with ApprovalRefusedError unless the CV version exists,
 * belongs to the job and has its exported PDF (path + SHA-256), at least one valid domain is
 * given (PM M1), and the application is this job's and CV version's, has no record, is
 * approved or paused, and has no unexpired token (PM M2).
 */
export function createApproval(db: Conn, input: CreateApprovalInput, opts?: ClockOpts): Approval {
  if (injectionBlocked(db, input.jobId)) {
    throw new InvalidTransitionError("job", "injection flagged (not confirmed)", "approved");
  }
  const now = opts?.now ?? new Date();
  return db.transaction((tx) => {
    const cv = requireCvVersionOfJob(tx, input.jobId, input.cvVersionId);
    if (!cv.pdfPath || !Sha256Schema.safeParse(cv.pdfSha256).success) {
      throw new ApprovalRefusedError("pdf_missing", `CV version ${cv.id} has no exported PDF with its SHA-256`);
    }
    const allowedDomains = validDomains(input.allowedDomains);
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
        allowedDomains,
        // UC-08: valid 24 h; a caller may ask for less (tests), never for more.
        expiresAt: new Date(now.getTime() + Math.min(input.ttlMs ?? APPROVAL_TTL_MS, APPROVAL_TTL_MS)).toISOString(),
        createdAt: now.toISOString(),
      })
      .returning()
      .get();
  });
}

export function getApproval(db: Conn, token: string): Approval | undefined {
  return db.select().from(approvals).where(eq(approvals.token, token)).get();
}

/**
 * The newest token issued for an application (UC-08, or Ba's re-approval after expiry). The
 * engine keeps tokens out of task inputs (PM S5) and finds the one to check here. `usedOnly`:
 * the newest token an Apply spawn used, which the submission record cites (a re-approval issued
 * while Apply ran stays unused).
 */
export function latestApprovalForApplication(
  db: Conn,
  applicationId: number,
  opts: { usedOnly?: boolean } = {},
): Approval | undefined {
  return db
    .select()
    .from(approvals)
    .where(and(eq(approvals.applicationId, applicationId), opts.usedOnly ? isNotNull(approvals.usedAt) : undefined))
    .orderBy(desc(approvals.createdAt), desc(sql`rowid`))
    .limit(1)
    .get();
}

/**
 * Why the trust guard denies a token:
 * - used: first spawn, the token was already used (UC-11 f)
 * - not_used: resume, the token was never used; the first spawn consumes it (consumeApproval)
 * - application_mismatch: the token was issued for another application (e.g. a dry run's), or for none (PM M2)
 * - application_recorded: the application already has a submission record (PM M2)
 * - application_closed: the application is no longer approved or paused (PM M2)
 */
export const APPROVAL_DENIALS = [
  "not_found",
  "used",
  "not_used",
  "expired",
  "application_mismatch",
  "job_mismatch",
  "cv_mismatch",
  "domain_mismatch",
  "injection_flagged",
  "application_recorded",
  "application_closed",
] as const;
export type ApprovalDenial = (typeof APPROVAL_DENIALS)[number];
export type ApprovalCheck = { ok: true; approval: Approval } | { ok: false; reason: ApprovalDenial };

/** The `safety.denied` reason the engine appends when the trust guard denies a token (§10.2 rule 8). */
export const SAFETY_REASON_FOR_APPROVAL_DENIAL = {
  not_found: "no_token",
  used: "token_used",
  not_used: "token_unused",
  expired: "token_expired",
  application_mismatch: "wrong_application",
  job_mismatch: "wrong_job",
  cv_mismatch: "wrong_cv",
  domain_mismatch: "wrong_domain",
  injection_flagged: "injection_flagged",
  application_recorded: "application_closed",
  application_closed: "application_closed",
} as const satisfies Record<ApprovalDenial, SafetyDenialReason>;

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
    const [d] = validDomains([domain]) as [string];
    if (approval.allowedDomains.includes(d)) return approval;
    return tx
      .update(approvals)
      .set({ allowedDomains: [...approval.allowedDomains, d] })
      .where(eq(approvals.token, token))
      .returning()
      .get()!;
  });
}
