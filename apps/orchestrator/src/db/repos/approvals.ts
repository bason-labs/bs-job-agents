import { randomBytes } from "node:crypto";
import { LIMITS, isApplyBlockedByInjection } from "@bs-job-agents/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Conn } from "../client.js";
import { InvalidTransitionError, NotFoundError } from "../errors.js";
import { approvals, jobs } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { Approval } from "../types.js";

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

export interface CreateApprovalInput {
  jobId: number;
  cvVersionId: number;
  allowedDomains: string[];
  ttlMs?: number;
}

/**
 * UC-08 step 1: a single-use token bound to job + CV version + domains, valid 24 h.
 * Refused while the job is injection-flagged and Ba has not confirmed it (UC-07 b).
 */
export function createApproval(db: Conn, input: CreateApprovalInput, opts?: ClockOpts): Approval {
  if (injectionBlocked(db, input.jobId)) {
    throw new InvalidTransitionError("job", "injection flagged (not confirmed)", "approved");
  }
  const now = opts?.now ?? new Date();
  return db
    .insert(approvals)
    .values({
      token: randomBytes(32).toString("hex"),
      jobId: input.jobId,
      cvVersionId: input.cvVersionId,
      allowedDomains: input.allowedDomains.map(normalizeDomain),
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? APPROVAL_TTL_MS)).toISOString(),
      createdAt: now.toISOString(),
    })
    .returning()
    .get();
}

export function getApproval(db: Conn, token: string): Approval | undefined {
  return db.select().from(approvals).where(eq(approvals.token, token)).get();
}

export type ApprovalDenial =
  | "not_found"
  | "used"
  | "expired"
  | "job_mismatch"
  | "cv_mismatch"
  | "domain_mismatch"
  | "injection_flagged";
export type ApprovalCheck = { ok: true; approval: Approval } | { ok: false; reason: ApprovalDenial };

export interface ApprovalExpectation extends ClockOpts {
  jobId: number;
  cvVersionId: number;
  /** Host the action targets; subdomains of an allowed domain match. */
  domain?: string;
}

function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/\.$/, "");
}

export function domainAllowed(allowed: readonly string[], host: string): boolean {
  const h = normalizeDomain(host);
  return allowed.some((d) => h === d || h.endsWith(`.${d}`));
}

function evaluate(db: Conn, approval: Approval | undefined, expect: ApprovalExpectation): ApprovalCheck {
  if (!approval) return { ok: false, reason: "not_found" };
  if (approval.usedAt) return { ok: false, reason: "used" };
  if (approval.expiresAt <= nowIso(expect)) return { ok: false, reason: "expired" };
  if (approval.jobId !== expect.jobId) return { ok: false, reason: "job_mismatch" };
  if (approval.cvVersionId !== expect.cvVersionId) return { ok: false, reason: "cv_mismatch" };
  if (expect.domain !== undefined && !domainAllowed(approval.allowedDomains, expect.domain)) {
    return { ok: false, reason: "domain_mismatch" };
  }
  if (injectionBlocked(db, approval.jobId)) return { ok: false, reason: "injection_flagged" };
  return { ok: true, approval };
}

/** Read-only validation (the trust guard's check, §10.2 rules 1 and 4). */
export function checkApproval(db: Conn, token: string, expect: ApprovalExpectation): ApprovalCheck {
  return evaluate(db, getApproval(db, token), expect);
}

/** Validate and mark the token used, atomically. A second call returns `used`. */
export function consumeApproval(db: Conn, token: string, expect: ApprovalExpectation): ApprovalCheck {
  return db.transaction(
    (tx) => {
      const check = evaluate(tx, getApproval(tx, token), expect);
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

/** UC-11e: Ba confirmed a new domain (e.g. an ATS) for this token. */
export function addApprovalDomain(db: Conn, token: string, domain: string): Approval {
  const approval = getApproval(db, token);
  if (!approval) throw new NotFoundError("approval", token);
  const d = normalizeDomain(domain);
  if (approval.allowedDomains.includes(d)) return approval;
  return db
    .update(approvals)
    .set({ allowedDomains: [...approval.allowedDomains, d] })
    .where(eq(approvals.token, token))
    .returning()
    .get()!;
}
