// The QA gate (§7.1 gate, §7.2 step 7, UC-06, UC-07, UC-09): CV tailors → the orchestrator exports
// the PDF → QA reviews → pass (total ≥ 80, no hard fails) goes to review; a fail sends QA's fix list
// back to CV as a new round; after maxRounds (3) the job is escalated to Ba ("QA not passed").
// Rounds are separate tasks, each with its own attempts (§5.5: attempts are not QA rounds).
// One gate row per CV language (§6.3: a VI JD gets VI and EN), branch key `<jobId>:<lang>`.
//
// CV guidance (§5.7, AD-13), only when the job has resolved guidance: tailor gets the applied
// positions as data; the queue's truth check fails an attempt (not a round) before export; after
// QA the deterministic checkers' items (computed at export) are free; cv.review (the `reviewer`)
// runs only when QA passed this round, or on the round handed to Ba. The gate passes when QA passed
// and no fixable guidance miss remains; otherwise, below round 3, the next round gets QA's fixes
// plus one fix per fixable miss. Guidance never escalates: after round 3 the latest QA-passed
// round goes to Ba (else the latest without invented_claim, else the latest, escalated as today).
// QA's input, schema and pass rule are untouched (NG8).
import {
  citedActiveFactIds,
  completeGuidanceReview,
  guidanceAttention,
  hasFixableMiss,
  runGuidanceChecks,
  type CvLanguage,
  type CvOutput,
  type CvReviewOutput,
  type GateStepSchema,
  type QaFix,
  type QaOutput,
  type ReviewerItem,
  type TaskMasterCv,
  type VerifiedPdfFacts,
} from "@bs-job-agents/shared";
import type { z } from "zod";
import { createCvVersion, createQaReview, getJob, getQaReview, getStep, getTask, type Conn, type Step, type Task } from "../db/index.js";
import { appendGuidanceFactRequests, getGuidanceReview, saveGuidanceReview } from "../db/repos/guidance-reviews.js";
import { stepDef, type RunCtx, type Scope } from "./context.js";
import type { EngineCore } from "./core.js";
import { jobRef } from "./filters.js";
import { guidanceForJob, reviewRules, tailorGuidance } from "./guidance-context.js";
import type { GateRound, GateStepOutput } from "./state.js";
import { demoteBot } from "./demotion.js";
import { setStep } from "./steps.js";
import { createWorkflowTask, ensureStepRow } from "./task-factory.js";

type GateStep = z.infer<typeof GateStepSchema>;

/** What the orchestrator did after CV finished (§6.2): the exported PDF, its hash and its text. */
export interface CvExport {
  /** data/-relative, data/pdf/<pdfFileNameForFrame(frame)>. */
  pdfPath: string;
  sha256: string;
  pdfText: string;
  /** F5: the export's verified facts, for QA's page checks. */
  pdf: VerifiedPdfFacts;
  /** The frame's real link from the bridge, when it has one. */
  figmaFrameUrl: string | null;
  /** CV guidance: the task's master copy (facts and contact) the checkers compare with; null when unparsed. */
  masterCopy?: TaskMasterCv | null;
}

const LANG = (l: CvLanguage) => l.toUpperCase();

export function gateScope(conn: Conn, out: Pick<GateStepOutput, "jobId" | "language">, branchKey: string): Scope {
  const job = getJob(conn, out.jobId);
  return { branchKey, language: out.language, item: job ? jobRef(conn, job) : { jobId: out.jobId, title: "", company: "" } };
}

function producerTask(
  core: EngineCore,
  conn: Conn,
  ctx: RunCtx,
  step: GateStep,
  row: Step,
  scope: Scope,
  out: GateStepOutput,
  round: number,
  fixes: QaFix[],
  previousCvVersionId: number | null,
): GateRound {
  const guidance = tailorGuidance(out.guidance ?? null);
  const { task } = createWorkflowTask(core, conn, ctx, row, step.producer, scope, {
    gate: { language: out.language, round, fixes, comment: out.comment, previousCvVersionId, ...(guidance ? { guidance } : {}) },
  });
  return { pass: out.pass, round, producerTaskId: task.id, cvVersionId: null, checkerTaskId: null, qaReviewId: null, total: null, passed: null };
}

/** Start the gate for one language (round 1), or a new pass after Ba asked for changes (UC-09). */
export function startGate(
  core: EngineCore,
  conn: Conn,
  ctx: RunCtx,
  step: GateStep,
  scope: Scope & { language: CvLanguage },
  previous?: GateStepOutput,
  comment: string | null = null,
): Step {
  const row = ensureStepRow(conn, ctx, step.key, scope);
  const jobId = scope.item!.jobId;
  const out: GateStepOutput = {
    jobId,
    language: scope.language,
    pass: (previous?.pass ?? 0) + 1,
    comment,
    rounds: [...(previous?.rounds ?? [])],
    outcome: "running",
    cvVersionId: null,
    // Resolved once per pass, so every round and language of this pass follows the same snapshot.
    guidance: step.reviewer ? guidanceForJob(core, conn, jobId) : null,
    handing: null,
  };
  out.rounds.push(producerTask(core, conn, ctx, step, row, scope, out, 1, [], previous?.cvVersionId ?? null));
  return setStep(core, conn, row, "running", { output: out, round: 1, preview: `CV ${LANG(out.language)} round 1` });
}

/** Failures and pauses of the current round's tasks; the transitions themselves happen when a task settles. */
export function pollGate(core: EngineCore, conn: Conn, ctx: RunCtx, step: GateStep, row: Step): "active" | "failed" | "done" {
  const settled = (): "active" | "done" => (getStep(conn, row.id)?.status === "done" ? "done" : "active");
  const out = row.output as GateStepOutput;
  const last = out.handing ? roundOf(out, out.handing.round) : out.rounds.at(-1);
  if (!last) {
    setStep(core, conn, row, "failed", { error: "the gate has no round" });
    return "failed";
  }
  // CV guidance: a failed cv.review never fails the CV; the round completes without its judgement.
  const reviewer = last.guidance?.reviewerTaskId ? getTask(conn, last.guidance.reviewerTaskId) : undefined;
  if (reviewer && (reviewer.status === "failed" || reviewer.status === "interrupted") && !last.guidance!.completed) {
    core.log.warn(`cv.review task ${reviewer.id} failed (${reviewer.error ?? "no attempts left"}); the round goes on without its judgement`);
    completeRound(core, conn, ctx, step, row, structuredClone(out), last.round, null);
    return settled();
  }
  const tasks = [
    out.handing ? undefined : getTask(conn, last.producerTaskId),
    out.handing || last.checkerTaskId === null ? undefined : getTask(conn, last.checkerTaskId),
    reviewer,
  ].filter((t): t is Task => t !== undefined);
  const failed = tasks.find((t) => t !== reviewer && (t.status === "failed" || t.status === "interrupted"));
  if (failed) {
    // F1: a later round (asked for by guidance) that failed never loses an earlier QA-passed CV.
    const passed = [...out.rounds].reverse().find((r) => r.pass === out.pass && r.round < last.round && r.passed === true && r.cvVersionId !== null);
    if (passed && !out.handing) {
      const next = structuredClone(out);
      next.handing = { round: passed.round, outcome: "passed" };
      next.handNote = `Round ${last.round} could not be tailored (${failed.botName}.${failed.kind} failed: ${failed.error ?? "no attempts left"}); round ${passed.round}, which passed QA, went to review instead.`;
      finishGate(core, conn, ctx, step, row, next);
      return settled();
    }
    setStep(core, conn, row, "failed", { error: `${failed.botName}.${failed.kind} failed: ${failed.error ?? "no attempts left"}` });
    return "failed";
  }
  const paused = tasks.some((t) => t.status === "paused" || t.status === "waiting_limit");
  if (paused && row.status !== "paused") setStep(core, conn, row, "paused", { round: last.round });
  if (!paused && row.status === "paused") setStep(core, conn, row, "running", { round: last.round });
  return "active";
}

function gateOf(conn: Conn, ctx: RunCtx, task: Task): { row: Step; step: GateStep; out: GateStepOutput } | null {
  const row = task.stepId === null ? undefined : getStep(conn, task.stepId);
  const step = row ? stepDef(ctx, row.stepKey) : undefined;
  if (!row || step?.type !== "gate" || row.status === "done" || row.status === "failed" || row.status === "cancelled") return null;
  return { row, step, out: structuredClone(row.output as GateStepOutput) };
}

const roundOf = (out: GateStepOutput, n: number): GateRound | undefined => out.rounds.find((r) => r.pass === out.pass && r.round === n);

/** CV finished and its PDF was exported: store the CV version, run the guidance checkers, then QA reviews it. */
export function onProducerDone(core: EngineCore, conn: Conn, ctx: RunCtx, task: Task, output: CvOutput, exported: CvExport): void {
  const gate = gateOf(conn, ctx, task);
  if (!gate) return;
  const { row, step, out } = gate;
  const round = out.rounds.find((r) => r.producerTaskId === task.id);
  if (!round) return;
  const cv = createCvVersion(
    conn,
    {
      jobId: out.jobId,
      language: out.language,
      tailored: output.tailored,
      figmaFrameName: output.figmaFrameName,
      figmaFrameUrl: exported.figmaFrameUrl ?? output.figmaFrameUrl,
      pdfPath: exported.pdfPath,
      pdfSha256: exported.sha256,
      changeNotes: output.changeNotes,
      factRequests: output.factRequests,
      masterVersion: ctx.masterVersion ?? 1,
      promptVersion: task.promptVersion ?? 1,
    },
    { now: core.now() },
  );
  round.cvVersionId = cv.id;
  if (out.guidance && exported.masterCopy) {
    // §5.6: the deterministic checkers, at no cost, on every round.
    const facts = exported.masterCopy.facts;
    const checks = runGuidanceChecks(out.guidance, { cv: output.tailored, pdfText: exported.pdfText, pageCount: exported.pdf.pageCount, facts, contact: exported.masterCopy.contact });
    const cited = new Set(citedActiveFactIds(output.tailored, facts));
    round.guidance = {
      checks,
      facts: facts.filter((f) => cited.has(f.id)).map((f) => ({ id: f.id, type: f.type, text: f.text, textVi: f.textVi, tags: f.tags, org: f.org, dates: f.dates })),
      reviewerTaskId: null,
      completed: false,
      fixes: 0,
      hasInventedClaim: false,
    };
  }
  const scope = gateScope(conn, out, row.branchKey);
  const { task: checker } = createWorkflowTask(core, conn, ctx, row, step.checker, scope, {
    checker: { cvVersionId: cv.id, pdfText: exported.pdfText, pdf: exported.pdf },
  });
  round.checkerTaskId = checker.id;
  setStep(core, conn, row, "running", { output: out, round: round.round, preview: `CV ${LANG(out.language)} round ${round.round}: QA reviewing` });
}

/** QA finished: pass → review (or cv.review first); fail → another round with QA's fixes; after maxRounds → escalate (UC-07 a). */
export function onCheckerDone(core: EngineCore, conn: Conn, ctx: RunCtx, task: Task, output: QaOutput): void {
  const gate = gateOf(conn, ctx, task);
  if (!gate) return;
  const { row, step, out } = gate;
  const round = out.rounds.find((r) => r.checkerTaskId === task.id);
  if (!round || round.cvVersionId === null) return;
  const review = createQaReview(
    conn,
    {
      cvVersionId: round.cvVersionId,
      total: output.total,
      scores: output.scores,
      hardFails: output.hardFails,
      fixes: output.fixes,
      injectionSuspected: output.injectionSuspected,
    },
    { now: core.now() },
  );
  round.qaReviewId = review.id;
  round.total = review.total;
  round.passed = review.passed;
  if (round.guidance) {
    round.guidance.hasInventedClaim = output.hardFails.some((h) => h.code === "invented_claim");
    // cv.review only on a QA-passed round (a failed one gets a new round anyway).
    if (review.passed && startReviewer(core, conn, ctx, step, row, out, round)) return;
    completeRound(core, conn, ctx, step, row, out, round.round, null, output);
    return;
  }
  if (review.passed) {
    out.outcome = "passed";
    out.cvVersionId = round.cvVersionId;
    setStep(core, conn, row, "done", { output: out, round: round.round, preview: `QA ${review.total} · passed` });
    return;
  }
  if (round.round < step.maxRounds) {
    const scope = gateScope(conn, out, row.branchKey);
    out.rounds.push(producerTask(core, conn, ctx, step, row, scope, out, round.round + 1, output.fixes, round.cvVersionId));
    setStep(core, conn, row, "running", {
      output: out,
      round: round.round + 1,
      preview: `QA ${review.total} · revising (round ${round.round + 1} of ${step.maxRounds})`,
    });
    return;
  }
  out.outcome = "escalated";
  out.cvVersionId = round.cvVersionId;
  // PM2 S8 (§5.3): a CV version that leaves the gate with hard fails demotes its producer; hard
  // fails the loop fixed earlier only reset the promotion streak.
  if (output.hardFails.length > 0) {
    const producer = getTask(conn, round.producerTaskId);
    demoteBot(core, conn, {
      botName: step.producer.bot,
      reason: "qa_hard_fail",
      detail: output.hardFails.map((h) => h.code).join(", "),
      taskId: producer?.id ?? null,
      runId: ctx.run.id,
    });
  }
  setStep(core, conn, row, "done", { output: out, round: round.round, preview: `QA not passed after ${step.maxRounds} rounds` });
}

/** Create cv.review for a round when there are judgement rules to judge; false when there are none. */
function startReviewer(core: EngineCore, conn: Conn, ctx: RunCtx, step: GateStep, row: Step, out: GateStepOutput, round: GateRound): boolean {
  if (!step.reviewer || !out.guidance || !round.guidance || round.cvVersionId === null) return false;
  const rules = reviewRules(out.guidance);
  if (rules.length === 0) return false;
  const checker = round.checkerTaskId === null ? undefined : getTask(conn, round.checkerTaskId);
  const pdfText = String((checker?.input as { pdfText?: unknown } | null)?.pdfText ?? "");
  const scope = gateScope(conn, out, row.branchKey);
  const { task } = createWorkflowTask(core, conn, ctx, row, step.reviewer, scope, {
    review: { cvVersionId: round.cvVersionId, pdfText, facts: round.guidance.facts, rules },
  });
  round.guidance.reviewerTaskId = task.id;
  setStep(core, conn, row, "running", { output: out, round: round.round, preview: `CV ${LANG(out.language)} round ${round.round}: CV guidance review` });
  return true;
}

/** cv.review finished: its items complete the round's review, then the gate decides. */
export function onReviewerDone(core: EngineCore, conn: Conn, ctx: RunCtx, task: Task, output: CvReviewOutput): void {
  const gate = gateOf(conn, ctx, task);
  if (!gate) return;
  const { row, step, out } = gate;
  const round = out.rounds.find((r) => r.pass === out.pass && r.guidance?.reviewerTaskId === task.id);
  if (!round) return;
  const items: ReviewerItem[] = output.items.map((i) => ({ ruleId: i.ruleId, status: i.status, reason: i.reason, fixable: i.fixable, fix: i.fix, needsFact: i.needsFact }));
  completeRound(core, conn, ctx, step, row, out, round.round, items);
}

/**
 * Store the round's review (deterministic items, plus cv.review's when it ran), then: pass, another
 * round (QA's fixes plus the guidance fixes), or, after the last round, hand the best round to Ba.
 */
function completeRound(core: EngineCore, conn: Conn, ctx: RunCtx, step: GateStep, row: Step, out: GateStepOutput, n: number, reviewer: ReviewerItem[] | null, qa?: QaOutput): void {
  const round = roundOf(out, n);
  if (!round?.guidance || round.cvVersionId === null || !out.guidance) return;
  const result = completeGuidanceReview(out.guidance, round.guidance.checks, reviewer, round.guidance.facts.map((f) => f.id), round.guidance.facts);
  saveGuidanceReview(conn, { cvVersionId: round.cvVersionId, result }, { now: core.now() });
  round.guidance.completed = true;
  round.guidance.fixes = result.fixes.length;
  if (out.handing) return finishGate(core, conn, ctx, step, row, out);
  const qaPassed = round.passed === true;
  if (qaPassed && !hasFixableMiss(result)) {
    out.outcome = "passed";
    out.cvVersionId = round.cvVersionId;
    recordPass(core, conn, out, round.cvVersionId);
    appendRequests(conn, round.cvVersionId);
    setStep(core, conn, row, "done", { output: out, round: n, preview: `QA ${round.total} · passed${guidanceNote(conn, round.cvVersionId)}` });
    return;
  }
  if (n < step.maxRounds) {
    const qaFixes = qaPassed ? [] : (qa?.fixes ?? getQaReview(conn, round.qaReviewId ?? -1)?.fixes ?? []);
    const guidanceFixes: QaFix[] = result.fixes.map((f) => ({ section: `CV guidance: ${f.point}`, instruction: f.instruction }));
    const scope = gateScope(conn, out, row.branchKey);
    out.rounds.push(producerTask(core, conn, ctx, step, row, scope, out, n + 1, [...qaFixes, ...guidanceFixes], round.cvVersionId));
    const why = qaPassed ? `QA ${round.total} passed · ${result.fixes.length} CV guidance fix${result.fixes.length === 1 ? "" : "es"}` : `QA ${round.total}`;
    setStep(core, conn, row, "running", { output: out, round: n + 1, preview: `${why} · revising (round ${n + 1} of ${step.maxRounds})` });
    return;
  }
  // The last round: the latest QA-passed round, else the latest without invented_claim, else the latest.
  const rounds = out.rounds.filter((r) => r.pass === out.pass && r.cvVersionId !== null);
  const handed = [...rounds].reverse().find((r) => r.passed === true) ?? [...rounds].reverse().find((r) => !r.guidance?.hasInventedClaim) ?? round;
  out.handing = { round: handed.round, outcome: handed.passed === true ? "passed" : "escalated" };
  // The handed round is judged by cv.review if it was not (REQ-38.AC-3: Ba sees what is not met).
  if (handed.guidance && !handed.guidance.reviewerTaskId) {
    handed.guidance.completed = false;
    if (startReviewer(core, conn, ctx, step, row, out, handed)) return;
    handed.guidance.completed = true;
  }
  finishGate(core, conn, ctx, step, row, out);
}

/** The pass is over: the handed round goes to Ba's review with its guidance result and fact requests. */
function finishGate(core: EngineCore, conn: Conn, ctx: RunCtx, step: GateStep, row: Step, out: GateStepOutput): void {
  const handed = out.handing ? roundOf(out, out.handing.round) : undefined;
  if (!handed || handed.cvVersionId === null || !out.handing) return;
  out.outcome = out.handing.outcome;
  out.cvVersionId = handed.cvVersionId;
  recordPass(core, conn, out, handed.cvVersionId);
  appendRequests(conn, handed.cvVersionId);
  const qa = handed.qaReviewId === null ? undefined : getQaReview(conn, handed.qaReviewId);
  // PM2 S8: demotion follows the round handed to review.
  if (out.outcome === "escalated" && qa && qa.hardFails.length > 0) {
    demoteBot(core, conn, { botName: step.producer.bot, reason: "qa_hard_fail", detail: qa.hardFails.map((h) => h.code).join(", "), taskId: handed.producerTaskId, runId: ctx.run.id });
  }
  const last = Math.max(...out.rounds.filter((r) => r.pass === out.pass).map((r) => r.round));
  const preview = out.outcome === "passed" ? `QA ${handed.total} · passed${guidanceNote(conn, handed.cvVersionId)}` : `QA not passed after ${step.maxRounds} rounds`;
  setStep(core, conn, row, "done", { output: out, round: last, preview });
}

/** F7: the handed version's review records the rounds of its own pass, and why it was handed. */
function recordPass(core: EngineCore, conn: Conn, out: GateStepOutput, cvVersionId: number): void {
  const stored = getGuidanceReview(conn, cvVersionId);
  if (!stored) return;
  const rounds = out.rounds.filter((r) => r.pass === out.pass && r.cvVersionId !== null).length;
  saveGuidanceReview(conn, { cvVersionId, result: { ...stored.result, rounds: Math.max(1, rounds), note: out.handNote ?? null } }, { now: core.now() });
}

function appendRequests(conn: Conn, cvVersionId: number): void {
  const stored = getGuidanceReview(conn, cvVersionId);
  if (!stored) return;
  const labels = new Map(stored.result.items.map((i) => [i.ruleId, i.point]));
  appendGuidanceFactRequests(conn, cvVersionId, stored.result.factRequests.map((r) => ({ ...r, ruleLabel: labels.get(r.ruleId) ?? r.ruleId })));
}

function guidanceNote(conn: Conn, cvVersionId: number): string {
  const stored = getGuidanceReview(conn, cvVersionId);
  if (!stored) return "";
  const n = guidanceAttention(stored.result).length;
  return n === 0 ? " · CV guidance met" : ` · ${n} CV guidance rule${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} you`;
}
