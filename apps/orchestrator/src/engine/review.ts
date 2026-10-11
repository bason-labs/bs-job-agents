// The human step (§7.2 step 8): the review card, and Ba's decisions on it.
// - UC-08 approve: the application, its bound single-use token (24 h) and the apply.submit task
//   in one transaction (F1 approveApplication + createTask). Approval covers ticking the
//   employer's consent box. After a denial (e.g. the token expired), approving again issues a
//   new token for the same application.
// - UC-09 request changes: Ba's comment starts a new QA-gate pass for each CV language.
// - UC-10 skip: the job is skipped with its reason; Apply and the record are skipped.
// Every decision is kept in the human step's output (PM brief: §5.3 promotion rule, sub-project C).
import {
  PRE_SUBMIT_APPLICATION_STATUSES,
  RequestChangesRequestSchema,
  SkipDecisionSchema,
  isApplyBlockedByInjection,
  publicHostProblem,
  type ActionStepSchema,
  type GateStepSchema,
  type HumanStepSchema,
  type SkipDecision,
} from "@bs-job-agents/shared";
import type { z } from "zod";
import {
  ApprovalRefusedError,
  InvalidTransitionError,
  approveApplication,
  clearJobInjection,
  createApproval,
  createTask,
  getApplication,
  getApplicationByJob,
  getCompany,
  getCvVersion,
  getJob,
  getStepByKey,
  getSubmissionRecord,
  holdEngineTasks,
  isEnginePaused,
  latestApprovalForApplication,
  listActiveRuns,
  listRuns,
  setJobStatus,
  skipJob,
  updateStepStatus,
  type Approval,
  type Conn,
  type Step,
} from "../db/index.js";
import { buildApplyPromptInput, emitApplication, moveApplication, registrableHost } from "./apply.js";
import { effectiveBot } from "./bots.js";
import { loadRunCtx, type RunCtx, type Scope } from "./context.js";
import type { EngineCore } from "./core.js";
import { EngineError, errorMessage, forbidden, invalidInput, invalidState, notFound } from "./errors.js";
import { jobRef } from "./filters.js";
import { startGate } from "./gate.js";
import type { ActionStepOutput, GateStepOutput, HumanStepOutput, ReviewCvOption, ReviewDecision } from "./state.js";
import { openStep, setStep } from "./steps.js";
import { ensureStepRow } from "./task-factory.js";
import { gateOutputsOf } from "./workflow.js";

type HumanStep = z.infer<typeof HumanStepSchema>;
type ActionStep = z.infer<typeof ActionStepSchema>;
type GateStep = z.infer<typeof GateStepSchema>;

function actionStepFor(ctx: RunCtx, human: HumanStep): ActionStep | undefined {
  return ctx.def.steps.find((s): s is ActionStep => s.type === "action" && s.approvalFrom === human.key);
}

/** Open (or re-open after changes) the review card once every CV language left the gate. */
export function startReview(core: EngineCore, conn: Conn, ctx: RunCtx, step: HumanStep, scope: Scope, row: Step | undefined): "active" | "failed" {
  const item = scope.item!;
  const finals = gateOutputsOf(conn, ctx, item).filter((g) => g.row.status === "done" && g.out.cvVersionId !== null);
  if (finals.length === 0) {
    openStep(core, conn, ctx, step.key, scope, "failed", { error: "no CV version came out of the QA gate" });
    return "failed";
  }
  const cvVersions: ReviewCvOption[] = finals.map(({ out }) => ({
    language: out.language,
    cvVersionId: out.cvVersionId!,
    qaPassed: out.outcome === "passed",
    escalated: out.outcome === "escalated",
  }));
  const factRequests = cvVersions.flatMap((c) => getCvVersion(conn, c.cvVersionId)?.factRequests ?? []);
  const output: HumanStepOutput = {
    jobId: item.jobId,
    cvVersions,
    // §6.3 / UC-08 a: a VI JD defaults to the VI version.
    defaultLanguage: cvVersions.some((c) => c.language === "vi") ? "vi" : cvVersions[0]!.language,
    qaPassed: cvVersions.every((c) => c.qaPassed),
    escalated: cvVersions.some((c) => c.escalated),
    needsInput: factRequests.length > 0,
    decisions: (row?.output as HumanStepOutput | null | undefined)?.decisions ?? [],
  };
  openStep(core, conn, ctx, step.key, scope, "waiting", { output, preview: output.escalated ? "QA not passed · Ba decides" : "waiting for Ba" });
  setJobStatus(conn, item.jobId, "reviewing");
  const action = actionStepFor(ctx, step);
  if (action) {
    const actionRow = getStepByKey(conn, ctx.run.id, action.key, scope.branchKey);
    if (!actionRow || actionRow.status === "pending") openStep(core, conn, ctx, action.key, scope, "locked");
  }
  const job = getJob(conn, item.jobId)!;
  core.bus.emit(conn, {
    type: "review.ready",
    jobId: String(job.id),
    runId: String(ctx.run.id),
    company: getCompany(conn, job.companyId)?.name ?? "",
    title: job.title,
    cvVersionIds: cvVersions.map((c) => String(c.cvVersionId)),
    qaPassed: output.qaPassed,
    escalated: output.escalated,
    needsInput: output.needsInput,
    injectionFlagged: isApplyBlockedByInjection(job),
  });
  return "active";
}

interface ReviewRef {
  ctx: RunCtx;
  scope: Scope;
  humanDef: HumanStep;
  human: Step;
  actionDef: ActionStep | undefined;
  action: Step | undefined;
}

/** The newest active run with a review step for this job (then any run, for a precise error). */
function findReview(core: EngineCore, conn: Conn, jobId: number): ReviewRef {
  for (const run of [...listActiveRuns(conn), ...listRuns(conn)]) {
    const ctx = loadRunCtx(core, run.id, conn);
    const humanDef = ctx?.def.steps.find((s): s is HumanStep => s.type === "human");
    if (!ctx || !humanDef) continue;
    const human = getStepByKey(conn, run.id, humanDef.key, String(jobId));
    if (!human) continue;
    const job = getJob(conn, jobId);
    const scope: Scope = { branchKey: String(jobId), item: job ? jobRef(conn, job) : { jobId, title: "", company: "" } };
    const actionDef = actionStepFor(ctx, humanDef);
    const action = actionDef ? getStepByKey(conn, run.id, actionDef.key, String(jobId)) : undefined;
    return { ctx, scope, humanDef, human, actionDef, action };
  }
  throw notFound("review card for job", jobId);
}

/** Apply was denied before it ran and the card waits for Ba to approve again (or skip). */
function awaitingReapproval(ref: ReviewRef): boolean {
  const out = ref.action?.output as ActionStepOutput | null | undefined;
  return (
    ref.human.status === "done" &&
    ref.action?.status === "locked" &&
    (out?.outcome === "denied" || out?.outcome === "not_started") &&
    out.applicationId !== null
  );
}

function decision(core: EngineCore, d: Partial<ReviewDecision> & Pick<ReviewDecision, "decision">): ReviewDecision {
  return { at: core.now().toISOString(), cvVersionId: null, introText: null, introEdited: false, comment: null, skip: null, ...d };
}

/** Keep the decision history without re-announcing the step. */
function recordDecision(conn: Conn, row: Step, d: ReviewDecision): void {
  const out = row.output as HumanStepOutput;
  updateStepStatus(conn, row.id, row.status, { output: { ...out, decisions: [...out.decisions, d] } });
}

export interface ApproveInput {
  cvVersionId: number;
  /** Ba's edited intro/cover text, or null for the generated one (UC-08 b). */
  introText: string | null;
  /** §12 dry-run acceptance: fill and screenshot, never submit. */
  dryRun?: boolean;
}

export interface ApproveResult {
  /** Null for an uploaded JD with no apply link: Approve only produced the PDF (§7.3b). */
  applicationId: number | null;
  taskId: number | null;
  approval: { expiresAt: string; allowedDomains: string[] } | null;
  /** True when this approval replaced an expired or denied token for the same application. */
  reapproval: boolean;
}

/** Queue apply.submit for an approved application; the prompt input never carries the token. */
function queueApply(core: EngineCore, conn: Conn, ref: ReviewRef, approval: Approval, introText: string | null, dryRun: boolean): number {
  const app = getApplication(conn, approval.applicationId!)!;
  const bot = effectiveBot(conn, core.deps.bots, "apply");
  const action = ref.action ?? ensureStepRow(conn, ref.ctx, ref.actionDef!.key, ref.scope);
  const prompt = buildApplyPromptInput(core, conn, ref.ctx, { application: app, approval, introText, answers: [] });
  const task = createTask(
    conn,
    {
      runId: ref.ctx.run.id,
      stepId: action.id,
      botName: "apply",
      kind: "submit",
      engine: bot.def.engine,
      input: prompt,
      promptVersion: bot.def.promptVersion,
      usesBrowser: true,
    },
    { now: core.now() },
  );
  if (isEnginePaused(conn, task.engine, { now: core.now() })) holdEngineTasks(conn, task.engine);
  const output: ActionStepOutput = { applicationId: app.id, taskId: task.id, dryRun, outcome: null, error: null, uploaded: null, answers: [], asked: [] };
  setStep(core, conn, action, "running", { output, preview: dryRun ? "dry run queued" : "queued" });
  return task.id;
}

function mapApprovalError(err: unknown): never {
  if (err instanceof InvalidTransitionError && err.from.startsWith("injection")) {
    throw forbidden("Apply is disabled for this job until Ba confirms the suspected injection (UC-07 b)");
  }
  if (err instanceof ApprovalRefusedError) throw invalidState(err.message, { reason: err.reason });
  if (err instanceof Error && /UNIQUE constraint failed: applications/.test(err.message)) {
    throw new EngineError("already_applied", "this job already has an application; use “apply again”");
  }
  throw err;
}

/** UC-08 Approve & submit (and a re-approval after a denied or expired token). */
export function approve(core: EngineCore, jobId: number, input: ApproveInput): ApproveResult {
  let runId = 0;
  const result = core.db.transaction((tx): ApproveResult => {
    const ref = findReview(core, tx, jobId);
    runId = ref.ctx.run.id;
    const humanOut = ref.human.output as HumanStepOutput;
    const actionOut = ref.action?.output as ActionStepOutput | null | undefined;
    const job = getJob(tx, jobId)!;
    const dryRun = input.dryRun === true;

    // A second approval for the same application, after Apply was denied before it ran.
    if (awaitingReapproval(ref)) {
      const app = getApplication(tx, actionOut!.applicationId!)!;
      if (input.cvVersionId !== app.cvVersionId) throw invalidInput("a re-approval keeps the approved CV version");
      if (!(PRE_SUBMIT_APPLICATION_STATUSES as readonly string[]).includes(app.status) || getSubmissionRecord(tx, app.id)?.submission) {
        throw invalidState(`application ${app.id} is ${app.status}; it cannot be approved again`);
      }
      // A token that is still unused and valid (e.g. denied while the job was injection-flagged,
      // then Ba confirmed it) is used as is; otherwise Ba's approval issues a new one.
      const latest = latestApprovalForApplication(tx, app.id);
      let approval: Approval;
      if (latest && latest.usedAt === null && latest.expiresAt > core.now().toISOString()) {
        approval = latest;
      } else {
        try {
          approval = createApproval(
            tx,
            { applicationId: app.id, jobId, cvVersionId: app.cvVersionId!, allowedDomains: [registrableHost(job.url!)] },
            { now: core.now() },
          );
        } catch (err) {
          return mapApprovalError(err);
        }
      }
      const taskId = queueApply(core, tx, { ...ref, action: ref.action }, approval, input.introText, app.dryRun);
      recordDecision(tx, ref.human, decision(core, { decision: "approve", cvVersionId: app.cvVersionId, introText: input.introText, introEdited: input.introText !== null, reapproval: true }));
      return { applicationId: app.id, taskId, approval: { expiresAt: approval.expiresAt, allowedDomains: approval.allowedDomains }, reapproval: true };
    }

    if (ref.human.status !== "waiting") throw invalidState(`the review card for job ${jobId} is not waiting for a decision`);
    if (!humanOut.cvVersions.some((c) => c.cvVersionId === input.cvVersionId)) {
      throw invalidInput(`CV version ${input.cvVersionId} is not on this review card`);
    }
    const d = decision(core, { decision: "approve", cvVersionId: input.cvVersionId, introText: input.introText, introEdited: input.introText !== null });
    // §7.3b: no apply link → Approve only produces the CV PDF for manual sending; nothing is submitted.
    if (!job.url) {
      setStep(core, tx, ref.human, "done", { output: { ...humanOut, decisions: [...humanOut.decisions, d] }, preview: "approved · no apply link" });
      if (ref.actionDef) openStep(core, tx, ref.ctx, ref.actionDef.key, ref.scope, "skipped", { output: { outcome: "no_apply_link" }, preview: "no apply link" });
      return { applicationId: null, taskId: null, approval: null, reapproval: false };
    }
    if (!ref.actionDef) throw invalidState("this workflow has no apply step");
    // PM2 M2: Apply is sent only to a public web site, never to Ba's Mac, his LAN or a bare suffix.
    const problem = publicHostProblem(registrableHost(job.url));
    if (problem) throw invalidState(`the job link's site is not a public web site, so Apply cannot be sent there: ${problem}`, { reason: "invalid_domain" });
    // §10.2 rule 5: one application per job unless the run says "apply again" (UC-14 a).
    const existing = getApplicationByJob(tx, jobId);
    const reapply = existing !== undefined && !dryRun && ref.ctx.params.applyAgain === true;
    if (existing && !reapply && !dryRun) throw new EngineError("already_applied", `job ${jobId} already has application ${existing.id}`);
    let created: ReturnType<typeof approveApplication>;
    try {
      created = approveApplication(
        tx,
        { jobId, cvVersionId: input.cvVersionId, allowedDomains: [registrableHost(job.url)], reapply, dryRun },
        { now: core.now() },
      );
    } catch (err) {
      return mapApprovalError(err);
    }
    const taskId = queueApply(core, tx, ref, created.approval, input.introText, dryRun);
    setStep(core, tx, ref.human, "done", { output: { ...humanOut, decisions: [...humanOut.decisions, d] }, preview: dryRun ? "approved (dry run)" : "approved" });
    emitApplication(core, tx, created.application);
    return {
      applicationId: created.application.id,
      taskId,
      approval: { expiresAt: created.approval.expiresAt, allowedDomains: created.approval.allowedDomains },
      reapproval: false,
    };
  });
  core.advance(runId);
  core.dispatch();
  return result;
}

/** UC-09: Ba's comment becomes the fix list for a new QA-gate pass, then the card returns. */
export function requestChanges(core: EngineCore, jobId: number, comment: string): void {
  const parsed = RequestChangesRequestSchema.safeParse({ comment });
  if (!parsed.success) throw invalidInput("type what to change");
  const runId = core.db.transaction((tx) => {
    const ref = findReview(core, tx, jobId);
    if (ref.human.status !== "waiting") throw invalidState(`the review card for job ${jobId} is not waiting for a decision`);
    const gate = ref.ctx.def.steps.find((s): s is GateStep => s.type === "gate" && s.key === ref.humanDef.onRequestChanges)
      ?? ref.ctx.def.steps.find((s): s is GateStep => s.type === "gate");
    if (!gate) throw invalidState("this workflow has no QA gate to send changes to");
    const out = ref.human.output as HumanStepOutput;
    setStep(core, tx, ref.human, "pending", {
      output: { ...out, decisions: [...out.decisions, decision(core, { decision: "request_changes", comment: parsed.data.comment })] },
      preview: "changes requested",
    });
    for (const { row, out: gateOut } of gateOutputsOf(tx, ref.ctx, ref.scope.item!)) {
      if (row.status !== "done") continue;
      startGate(core, tx, ref.ctx, gate, { branchKey: row.branchKey, item: ref.scope.item, language: gateOut.language }, gateOut as GateStepOutput, parsed.data.comment);
    }
    return ref.ctx.run.id;
  });
  core.advance(runId);
  core.dispatch();
}

/** UC-10: skip with a reason (input for sub-project D). */
export function skip(core: EngineCore, jobId: number, input: SkipDecision): void {
  const parsed = SkipDecisionSchema.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error.issues.map((i) => i.message).join("; "));
  const runId = core.db.transaction((tx) => {
    const ref = findReview(core, tx, jobId);
    const afterDenial = awaitingReapproval(ref);
    if (ref.human.status !== "waiting" && !afterDenial) throw invalidState(`the review card for job ${jobId} is not waiting for a decision`);
    skipJob(tx, jobId, { reason: parsed.data.reason, note: parsed.data.note });
    const out = ref.human.output as HumanStepOutput;
    const d = decision(core, { decision: "skip", skip: { reason: parsed.data.reason, note: parsed.data.note } });
    if (afterDenial) {
      // Ba gives up after Apply was denied: the approved application never ran.
      recordDecision(tx, ref.human, d);
      const appId = (ref.action!.output as ActionStepOutput).applicationId!;
      moveApplication(core, tx, appId, "failed", `skipped after Apply was denied: ${parsed.data.reason}`);
    } else {
      setStep(core, tx, ref.human, "done", { output: { ...out, decisions: [...out.decisions, d] }, preview: `skipped: ${parsed.data.reason}` });
    }
    if (ref.actionDef) openStep(core, tx, ref.ctx, ref.actionDef.key, ref.scope, "skipped", { preview: "skipped" });
    const record = ref.ctx.def.steps.find((s) => s.type === "record" && s.branch === ref.humanDef.branch);
    if (record) openStep(core, tx, ref.ctx, record.key, ref.scope, "skipped", { output: { recorded: false } });
    return ref.ctx.run.id;
  });
  core.advance(runId);
  core.dispatch();
}

/**
 * UC-07 b (PM2 S2): Ba confirms a job QA flagged for a suspected injection is safe to apply to. The
 * flag's clearing is audited as a shared event (`injection.confirmed`), with the run of its card.
 */
export function confirmInjection(core: EngineCore, jobId: number): void {
  core.db.transaction((tx) => {
    const job = getJob(tx, jobId);
    if (!job) throw notFound("job", jobId);
    if (!isApplyBlockedByInjection(job)) throw invalidState(`job ${jobId} is not waiting for an injection confirmation`);
    clearJobInjection(tx, jobId, { now: core.now() });
    let runId: number | null = null;
    try {
      runId = findReview(core, tx, jobId).ctx.run.id;
    } catch {
      runId = null; // a job without a review card (yet)
    }
    core.bus.emit(tx, { type: "injection.confirmed", jobId: String(jobId), runId: runId === null ? null : String(runId) });
  });
  core.bus.flush();
}

/** The token a re-approval would replace, for callers that show its expiry (never its value). */
export function approvalStatus(conn: Conn, applicationId: number): { expiresAt: string; usedAt: string | null; allowedDomains: string[] } | null {
  const a = latestApprovalForApplication(conn, applicationId);
  return a ? { expiresAt: a.expiresAt, usedAt: a.usedAt, allowedDomains: a.allowedDomains } : null;
}

export { errorMessage };
