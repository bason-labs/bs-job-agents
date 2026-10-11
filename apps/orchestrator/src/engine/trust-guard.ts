// Trust guard (§3 rule 6, §5.3, §10.2 rules 1, 2 and 4). Two checks run before any spawn:
// 1. checkTaskTrust: may this bot run this task at all? Keyed on the task, not on the level
//    (PM S1): an outward-facing task (apply.submit) always needs an approval token, even if Apply
//    sits at L2 in the database. L0 never acts outward; a definition that breaks the Phase 1
//    safety rules (S6) never runs.
// 2. The approval token, for outward-facing tasks: the newest token issued for the application
//    (tokens never sit in task inputs, PM S5). The first spawn consumes it (consumeApproval); a
//    resume of the same application re-validates it (checkApprovalForResume, PM M2). A used
//    token on a first spawn is a reuse and is denied.
import { checkBotSafety, isOutwardFacingTask, taskKey, type SafetyDenialReason } from "@bs-job-agents/shared";
import {
  SAFETY_REASON_FOR_APPROVAL_DENIAL,
  checkApproval,
  checkApprovalForResume,
  consumeApproval,
  getApproval,
  latestApprovalForApplication,
  type Approval,
  type ApprovalCheck,
  type ApprovalDenial,
  type Conn,
} from "../db/index.js";
import { isConversationKind, type EffectiveBot } from "./bots.js";

export type TrustDecision = { ok: true; needsApproval: boolean } | { ok: false; reason: SafetyDenialReason; detail: string };

export function checkTaskTrust(bot: EffectiveBot, kind: string): TrustDecision {
  const key = taskKey(bot.def.name, kind);
  if (!bot.enabled) return { ok: false, reason: "trust_level", detail: `${bot.def.name} is disabled` };
  // Owner decision 2026-10-11: CV on Codex only with Ba's opt-in (never Apply or Lead).
  const unsafe = checkBotSafety({ ...bot.def, trustLevel: bot.def.trustLevel }, { unguardedFigmaAcknowledged: bot.engineRiskAcknowledged === true });
  if (unsafe.length > 0) return { ok: false, reason: "trust_level", detail: unsafe.join("; ") };
  // Consult (UC-25) and discussion (UC-15) run with read-only tools; nothing outward happens.
  if (isConversationKind(kind)) return { ok: true, needsApproval: false };
  if (!isOutwardFacingTask(bot.def.name, kind)) return { ok: true, needsApproval: false };
  if (bot.trustLevel === 0) return { ok: false, reason: "trust_level", detail: `${bot.def.name} is L0 (draft only): ${key} is outward-facing` };
  return { ok: true, needsApproval: true };
}

export interface ApplyGuardRequest {
  applicationId: number;
  jobId: number;
  cvVersionId: number;
  /** Host Apply starts on (the job URL's); always checked against the token's domains. */
  domain: string;
  /** Apply paused itself on an earlier spawn of this task and Ba acted (UC-11 a/b/e, UC-12, UC-17). */
  resume: boolean;
  now: Date;
}

export type ApplyGuardResult =
  | { ok: true; approval: Approval; mode: "first" | "resume" }
  | { ok: false; denial: ApprovalDenial; reason: SafetyDenialReason; detail: string };

export function safetyReasonFor(denial: ApprovalDenial): SafetyDenialReason {
  return SAFETY_REASON_FOR_APPROVAL_DENIAL[denial];
}

const DENIAL_TEXT: Record<ApprovalDenial, string> = {
  not_found: "no approval token for this application",
  used: "the approval token was already used",
  not_used: "the approval token was never used",
  expired: "the approval token expired (24 h); approve again on the review card",
  application_mismatch: "the approval token was issued for another application",
  job_mismatch: "the approval token was issued for another job",
  cv_mismatch: "the approval token was issued for another CV version",
  domain_mismatch: "the site is not one of the approved domains",
  injection_flagged: "the job is flagged for a suspected injection and Ba has not confirmed it",
  application_recorded: "the application already has a submission record",
  application_closed: "the application left the apply flow",
};

function result(check: ApprovalCheck, mode: "first" | "resume"): ApplyGuardResult {
  if (check.ok) return { ok: true, approval: check.approval, mode };
  return { ok: false, denial: check.reason, reason: safetyReasonFor(check.reason), detail: DENIAL_TEXT[check.reason] };
}

/**
 * Check an explicit token: `check` (read-only first spawn), `consume` (first spawn, atomic) or
 * `resume` (re-validate a used token for the same application).
 */
export function checkToken(db: Conn, token: string, req: ApplyGuardRequest, use: "check" | "consume" | "resume"): ApplyGuardResult {
  const expect = {
    applicationId: req.applicationId,
    jobId: req.jobId,
    cvVersionId: req.cvVersionId,
    domain: req.domain,
    now: req.now,
  };
  if (use === "resume") return result(checkApprovalForResume(db, token, expect), "resume");
  return result(use === "consume" ? consumeApproval(db, token, expect) : checkApproval(db, token, expect), "first");
}

/** The token to use and whether this spawn is a resume of it. */
function pick(db: Conn, req: ApplyGuardRequest): { approval: Approval; mode: "first" | "resume" } | null {
  const approval = latestApprovalForApplication(db, req.applicationId);
  if (!approval) return null;
  // Ba re-approved after expiry: the new, unused token makes this a first spawn again.
  return { approval, mode: approval.usedAt !== null && req.resume ? "resume" : "first" };
}

const noToken: ApplyGuardResult = { ok: false, denial: "not_found", reason: safetyReasonFor("not_found"), detail: DENIAL_TEXT.not_found };

/** Read-only check before the engine copies files for Apply. */
export function precheckApplyToken(db: Conn, req: ApplyGuardRequest): ApplyGuardResult {
  const p = pick(db, req);
  if (!p) return noToken;
  return checkToken(db, p.approval.token, req, p.mode === "resume" ? "resume" : "check");
}

/** Just before spawning Apply: consume the token (first spawn) or re-validate it (resume). */
export function authorizeApplyToken(db: Conn, req: ApplyGuardRequest): ApplyGuardResult {
  const p = pick(db, req);
  if (!p) return noToken;
  const r = checkToken(db, p.approval.token, req, p.mode === "resume" ? "resume" : "consume");
  // Return the row as it is now (used_at set by the consume).
  return r.ok ? { ...r, approval: getApproval(db, r.approval.token) ?? r.approval } : r;
}
