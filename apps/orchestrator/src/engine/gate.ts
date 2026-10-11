// The QA gate (§7.1 gate, §7.2 step 7, UC-06, UC-07, UC-09): CV tailors → the orchestrator exports
// the PDF → QA reviews → pass (total ≥ 80, no hard fails) goes to review; a fail sends QA's fix list
// back to CV as a new round; after maxRounds (3) the job is escalated to Ba ("QA not passed").
// Rounds are separate tasks, each with its own attempts (§5.5: attempts are not QA rounds).
// One gate row per CV language (§6.3: a VI JD gets VI and EN), branch key `<jobId>:<lang>`.
import type { CvLanguage, CvOutput, GateStepSchema, QaFix, QaOutput, VerifiedPdfFacts } from "@bs-job-agents/shared";
import type { z } from "zod";
import { createCvVersion, createQaReview, getJob, getStep, getTask, type Conn, type Step, type Task } from "../db/index.js";
import { stepDef, type RunCtx, type Scope } from "./context.js";
import type { EngineCore } from "./core.js";
import { jobRef } from "./filters.js";
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
  const { task } = createWorkflowTask(core, conn, ctx, row, step.producer, scope, {
    gate: { language: out.language, round, fixes, comment: out.comment, previousCvVersionId },
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
  const out: GateStepOutput = {
    jobId: scope.item!.jobId,
    language: scope.language,
    pass: (previous?.pass ?? 0) + 1,
    comment,
    rounds: [...(previous?.rounds ?? [])],
    outcome: "running",
    cvVersionId: null,
  };
  out.rounds.push(producerTask(core, conn, ctx, step, row, scope, out, 1, [], previous?.cvVersionId ?? null));
  return setStep(core, conn, row, "running", { output: out, round: 1, preview: `CV ${LANG(out.language)} round 1` });
}

/** Failures and pauses of the current round's tasks; the transitions themselves happen when a task settles. */
export function pollGate(core: EngineCore, conn: Conn, row: Step): "active" | "failed" {
  const out = row.output as GateStepOutput;
  const last = out.rounds.at(-1);
  if (!last) {
    setStep(core, conn, row, "failed", { error: "the gate has no round" });
    return "failed";
  }
  const tasks = [getTask(conn, last.producerTaskId), last.checkerTaskId === null ? undefined : getTask(conn, last.checkerTaskId)].filter(
    (t): t is Task => t !== undefined,
  );
  const failed = tasks.find((t) => t.status === "failed" || t.status === "interrupted");
  if (failed) {
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

/** CV finished and its PDF was exported: store the CV version, then QA reviews it. */
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
  const scope = gateScope(conn, out, row.branchKey);
  const { task: checker } = createWorkflowTask(core, conn, ctx, row, step.checker, scope, {
    checker: { cvVersionId: cv.id, pdfText: exported.pdfText, pdf: exported.pdf },
  });
  round.checkerTaskId = checker.id;
  setStep(core, conn, row, "running", { output: out, round: round.round, preview: `CV ${LANG(out.language)} round ${round.round}: QA reviewing` });
}

/** QA finished: pass → review; fail → another round with QA's fixes; after maxRounds → escalate (UC-07 a). */
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
