// The apply path (UC-08 → UC-11 → §9.1), on the F1 repository API:
// - approve: approveApplication + the apply.submit task in one transaction (review.ts);
// - before each spawn: read-only token check, copy the approved PDF into
//   data/applications/<id>/ and re-hash the copy (decision 2b; a mismatch aborts before anything
//   runs: markSubmissionRefused), then consume the token (first spawn) or re-validate it (resume);
// - the bot gets `splitApplySubmitInput(full).prompt`: the token never reaches a prompt, a
//   transcript, a task row or the UI (PM S5);
// - on the result: pauses Apply reports itself wait for Ba (UC-11 a/b/e, UC-12, UC-17); anything
//   else after a spawn that is not a clean result goes to needs_check, never retried (PM FYI c);
// - the record step writes the §9.1 record with the ORCHESTRATOR's hash of the uploaded copy.
import {
  ApplyOutputSchema,
  ApplyPromptInputSchema,
  BOT_TASK_INPUT_SCHEMAS,
  canTransitionApplicationStatus,
  parsePauseReason,
  splitApplySubmitInput,
  type ApplyOutput,
  type ApplyPromptInput,
  type CvLanguage,
  type PendingQuestion,
  type QuestionAnswer,
} from "@bs-job-agents/shared";
import {
  SubmissionRefusedError,
  addApprovalDomain,
  appendMessage,
  getApplication,
  getCompany,
  getCvVersion,
  getJob,
  getOrCreateLeadRoom,
  getStep,
  getSubmissionRecord,
  getTask,
  latestApprovalForApplication,
  listSavedAnswers,
  mappers,
  markSubmissionRefused,
  recordSubmission,
  saveAnswer,
  transitionApplication,
  updateTaskInput,
  type Application,
  type Approval,
  type Conn,
  type Step,
  type Task,
} from "../db/index.js";
import { formDefaultsOf, loadRunCtx, type RunCtx, type Scope } from "./context.js";
import type { EngineCore } from "./core.js";
import { errorMessage, invalidInput, invalidState, notFound } from "./errors.js";
import { resolvePendingQuestion, validateBaAnswer, type BaAnswerMode, type QuestionContext } from "./questions.js";
import type { ActionStepOutput, RecordStepOutput } from "./state.js";
import { openStep, setStep } from "./steps.js";
import { emitSafetyDenied, emitTaskPaused, failTaskNow, resumeTaskNow, stillRunning } from "./task-events.js";
import { authorizeApplyToken, precheckApplyToken, type ApplyGuardRequest } from "./trust-guard.js";

/** PM brief: allowed domains come from the job URL's host without `www.` / `m.`. */
export function registrableHost(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/\.$/, "").replace(/^(www\.|m\.)/, "");
}

const asciiUpper = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toUpperCase();

/** PM FYI d: what employers see, e.g. BA_HUYNH_NOVAPAY_EN.pdf (not the internal frame name). */
export function recruiterFileName(applicant: string, company: string, language: CvLanguage): string {
  const slug = (s: string) => asciiUpper(s).replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "CV";
  return `${slug(applicant).replace(/-/g, "_")}_${slug(company)}_${language.toUpperCase()}.pdf`;
}

/** Apply paused itself on an earlier spawn (its paused output is kept on the task). */
export function isApplyPause(output: unknown): output is ApplyOutput {
  return (output as { status?: unknown } | null)?.status === "paused";
}

function formLanguage(conn: Conn, jobId: number): "en" | "vi" {
  return getJob(conn, jobId)?.language === "vi" ? "vi" : "en";
}

function actionRowOf(conn: Conn, task: Pick<Task, "stepId">): Step | undefined {
  return task.stepId === null ? undefined : getStep(conn, task.stepId);
}

function updateAction(core: EngineCore, conn: Conn, row: Step, patch: Partial<ActionStepOutput>, preview?: string): Step {
  const out = { ...(row.output as ActionStepOutput), ...patch };
  return setStep(core, conn, row, row.status === "locked" ? "running" : row.status, { output: out, ...(preview ? { preview } : {}) });
}

function emitApplication(core: EngineCore, conn: Conn, app: Application): void {
  core.bus.emit(conn, {
    type: "application.updated",
    applicationId: String(app.id),
    jobId: String(app.jobId),
    status: app.status,
    origin: app.origin,
  });
}

/** System change of an application in the apply flow, if the shared status machine allows it. */
export function moveApplication(core: EngineCore, conn: Conn, applicationId: number, to: Application["status"], note: string): Application | null {
  const app = getApplication(conn, applicationId);
  if (!app || app.status === to || !canTransitionApplicationStatus(app.status, to, "system", { dryRun: app.dryRun })) return null;
  const moved = transitionApplication(conn, app.id, to, { now: core.now(), note });
  emitApplication(core, conn, moved);
  return moved;
}

// ---------------------------------------------------------------- the prompt input

/** apply.submit as the bot sees it (shared ApplyPromptInputSchema: everything but the token). */
export function buildApplyPromptInput(
  core: EngineCore,
  conn: Conn,
  ctx: RunCtx | null,
  args: { application: Application; approval: Approval; introText: string | null; answers: QuestionAnswer[] },
): ApplyPromptInput {
  const app = args.application;
  const job = getJob(conn, app.jobId);
  const cv = app.cvVersionId === null ? undefined : getCvVersion(conn, app.cvVersionId);
  const company = job ? getCompany(conn, job.companyId) : undefined;
  if (!job?.url || !cv || !company) throw invalidState(`application ${app.id} has no job link, CV version or company`);
  const file = recruiterFileName(core.config.applicantName, company.name, cv.language);
  const defaults = formDefaultsOf(ctx);
  return ApplyPromptInputSchema.parse({
    applicationId: String(app.id),
    jobId: String(job.id),
    cvVersionId: String(cv.id),
    jobUrl: job.url,
    expectedCompany: company.name,
    expectedTitle: job.title,
    allowedDomains: args.approval.allowedDomains,
    pdfPath: core.paths.abs(`${core.paths.applicationDir(app.id)}/${file}`),
    pdfSha256: cv.pdfSha256,
    introText: args.introText,
    savedAnswers: listSavedAnswers(conn).map((s) => ({ key: s.key, label: s.label, answer: s.answer })),
    answers: args.answers,
    formDefaults: { salaryPolicy: defaults.salaryPolicy, salaryAmount: defaults.salaryAmount, currency: defaults.currency },
    dryRun: app.dryRun,
  });
}

// ---------------------------------------------------------------- before the spawn

export type ApplyPrep = { kind: "ready"; input: ApplyPromptInput; readDir: string; allowedSites: string[] } | { kind: "stopped" };

/** Refused before anything ran (trust guard): the task fails, the application stays as it was. */
function deny(core: EngineCore, task: Task, reason: Parameters<typeof emitSafetyDenied>[2]["reason"], detail: string): ApplyPrep {
  core.db.transaction((tx) => {
    failTaskNow(core, tx, task, `denied: ${detail}`);
    emitSafetyDenied(core, tx, { botName: task.botName, taskId: task.id, action: "apply.submit", reason, detail });
    const row = actionRowOf(tx, task);
    if (row) updateAction(core, tx, row, { outcome: "denied", error: detail });
  });
  return { kind: "stopped" };
}

/** Decision 2b: the copy is not the approved file. Abort before spawning; needs_check + safety.denied. */
function refuse(core: EngineCore, task: Task, app: Application, detail: string): ApplyPrep {
  core.db.transaction((tx) => {
    const { application } = markSubmissionRefused(
      tx,
      { error: new SubmissionRefusedError("sha_mismatch", app.id, detail), taskId: task.id, botName: task.botName },
      { now: core.now() },
    );
    emitApplication(core, tx, application);
    failTaskNow(core, tx, task, `refused: ${detail}`);
    const row = actionRowOf(tx, task);
    if (row) updateAction(core, tx, row, { outcome: "refused", error: detail });
  });
  return { kind: "stopped" };
}

export async function prepareApply(core: EngineCore, task: Task): Promise<ApplyPrep> {
  const db = core.db;
  const stored = (task.input ?? {}) as Partial<ApplyPromptInput>;
  const app = getApplication(db, Number(stored.applicationId));
  if (!app) return deny(core, task, "no_token", `application ${String(stored.applicationId)} not found`);
  const job = getJob(db, app.jobId);
  const cv = app.cvVersionId === null ? undefined : getCvVersion(db, app.cvVersionId);
  const company = job ? getCompany(db, job.companyId) : undefined;
  if (!job?.url || !cv?.pdfPath || !company) return deny(core, task, "no_token", `application ${app.id} has no job link or approved PDF`);
  const req: ApplyGuardRequest = {
    applicationId: app.id,
    jobId: Number(stored.jobId ?? app.jobId),
    cvVersionId: Number(stored.cvVersionId ?? app.cvVersionId),
    domain: registrableHost(job.url),
    resume: isApplyPause(task.output),
    now: core.now(),
  };
  const pre = precheckApplyToken(db, req);
  if (!pre.ok) return deny(core, task, pre.reason, pre.detail);

  // Decision 2b: Apply uploads a copy in its own folder, named for the employer (PM FYI d); the
  // copy's hash must be the approved one, or nothing runs (W2c copyFileVerified removes the copy).
  const dirRel = core.paths.applicationDir(app.id);
  const fileRel = `${dirRel}/${recruiterFileName(core.config.applicantName, company.name, cv.language)}`;
  if (!cv.pdfSha256) return refuse(core, task, app, `CV version ${cv.id} has no approved SHA-256`);
  let sha256: string;
  try {
    ({ sha256 } = await core.deps.files.copyVerified(core.paths.abs(cv.pdfPath), core.paths.abs(fileRel), cv.pdfSha256));
  } catch (err) {
    return refuse(core, task, app, `the approved PDF failed its check before upload: ${errorMessage(err)}`);
  }
  if (!stillRunning(db, task.id)) return { kind: "stopped" };

  const auth = authorizeApplyToken(db, { ...req, now: core.now() });
  if (!auth.ok) return deny(core, task, auth.reason, auth.detail);

  return db.transaction((tx) => {
    const ctx = task.runId === null ? null : loadRunCtx(core, task.runId, tx);
    const row = actionRowOf(tx, task);
    const prompt = buildApplyPromptInput(core, tx, ctx, {
      application: app,
      approval: auth.approval,
      introText: stored.introText ?? null,
      answers: (row?.output as ActionStepOutput | null)?.answers ?? [],
    });
    // Validate the full input (with the token), then keep only the prompt part (PM S5).
    const full = BOT_TASK_INPUT_SCHEMAS["apply.submit"].parse({ ...prompt, approvalToken: auth.approval.token });
    const input = splitApplySubmitInput(full).prompt;
    updateTaskInput(tx, task.id, input);
    if (row) updateAction(core, tx, row, { uploaded: { filename: fileRel.split("/").at(-1)!, path: fileRel, sha256 } }, auth.mode === "resume" ? "resuming" : "applying");
    moveApplication(core, tx, app.id, "approved", "Apply resumed");
    return { kind: "ready" as const, input, readDir: core.paths.abs(dirRel), allowedSites: auth.approval.allowedDomains };
  });
}

// ---------------------------------------------------------------- after the spawn

/** Apply reported submitted or needs_check. A dry run that says submitted is a safety event (PM §7). */
export function onApplyDone(core: EngineCore, conn: Conn, task: Task, output: ApplyOutput): void {
  const row = actionRowOf(conn, task);
  const out = row?.output as ActionStepOutput | undefined;
  if (out?.dryRun && output.status === "submitted") {
    emitSafetyDenied(core, conn, {
      botName: task.botName,
      taskId: task.id,
      action: "apply.submit",
      reason: "dry_run_submitted",
      detail: "a dry run reported submitted; it may really have submitted, so it needs a check",
    });
  }
  if (row) updateAction(core, conn, row, { outcome: output.status === "submitted" && !out?.dryRun ? "submitted" : "needs_check" });
}

/** After a spawn, anything but a clean result or a pause: needs_check, never retried (UC-11 c, PM FYI c). */
export function onApplyFailedAfterSpawn(core: EngineCore, conn: Conn, task: Task, error: string): void {
  const row = actionRowOf(conn, task);
  const appId = Number((task.input as Partial<ApplyPromptInput> | null)?.applicationId);
  if (Number.isInteger(appId)) moveApplication(core, conn, appId, "needs_check", `Apply did not finish cleanly: ${error}`);
  if (row) updateAction(core, conn, row, { outcome: "needs_check", error });
}

function questionContext(core: EngineCore, conn: Conn, task: Task, jobId: number): QuestionContext {
  const ctx = task.runId === null ? null : loadRunCtx(core, task.runId, conn);
  const defaults = formDefaultsOf(ctx);
  return {
    salaryPolicy: defaults.salaryPolicy,
    salaryAmount: defaults.salaryAmount,
    currency: defaults.currency,
    formLanguage: formLanguage(conn, jobId),
    savedAnswers: listSavedAnswers(conn),
  };
}

/** Questions still waiting for Ba, in Apply's order. */
function questionsForBa(core: EngineCore, conn: Conn, task: Task, output: ApplyOutput, out: ActionStepOutput, jobId: number) {
  const qctx = questionContext(core, conn, task, jobId);
  const auto: QuestionAnswer[] = [];
  const ask: PendingQuestion[] = [];
  for (const q of output.pendingQuestions) {
    if (out.answers.some((a) => a.field === q.field)) continue;
    const r = resolvePendingQuestion(q, qctx);
    if (r.kind === "ask") ask.push(q);
    else auto.push(r.answer);
  }
  return { auto, ask };
}

function postQuestion(core: EngineCore, conn: Conn, task: Task, applicationId: number, q: PendingQuestion): void {
  const room = getOrCreateLeadRoom(conn, { now: core.now() });
  const app = getApplication(conn, applicationId);
  const job = app ? getJob(conn, app.jobId) : undefined;
  const company = job ? getCompany(conn, job.companyId)?.name : undefined;
  const message = appendMessage(
    conn,
    {
      roomId: room.id,
      author: "lead",
      text: `Apply needs an answer${company ? ` for ${company}` : ""}: ${q.label}${q.required ? "" : " (optional)"}`,
      meta: { cards: [{ type: "question", applicationId: String(applicationId), taskId: String(task.id), question: q, answered: false }] },
    },
    { now: core.now() },
  );
  core.bus.emit(conn, { type: "message.created", roomId: String(room.id), message: mappers.toMessage(message, room.kind, []) });
}

/**
 * Apply paused itself (UC-11 a/b/e, UC-12, UC-17): the application waits as `paused`. Pending
 * questions are answered from saved answers and the form defaults where they decide; Lead asks
 * Ba the rest, one at a time. When nothing is left to ask, Apply resumes at once.
 */
export function onApplyPaused(core: EngineCore, conn: Conn, task: Task, output: ApplyOutput): void {
  const row = actionRowOf(conn, task);
  const out = (row?.output as ActionStepOutput | undefined) ?? null;
  const appId = Number((task.input as Partial<ApplyPromptInput> | null)?.applicationId);
  moveApplication(core, conn, appId, "paused", output.pauseReason?.detail ?? output.pauseReason?.reason ?? "pending questions");
  if (!row || !out || output.pendingQuestions.length === 0) return;
  const app = getApplication(conn, appId);
  const { auto, ask } = questionsForBa(core, conn, task, output, out, app?.jobId ?? 0);
  const answers = [...out.answers, ...auto];
  if (ask.length === 0 && output.pauseReason?.reason !== "needs_login" && output.pauseReason?.reason !== "captcha") {
    updateAction(core, conn, row, { answers });
    resumeTaskNow(core, conn, getTask(conn, task.id)!);
    return;
  }
  const next = ask.find((q) => !out.asked.includes(q.field));
  if (next) postQuestion(core, conn, task, appId, next);
  updateAction(core, conn, row, { answers, asked: next ? [...out.asked, next.field] : out.asked }, "waiting for Ba");
}

// ---------------------------------------------------------------- Ba acts on a pause

export interface AnswerInput {
  field: string;
  mode: BaAnswerMode;
  value: string | null;
  remember: boolean;
}

/** UC-12: Ba's answer, Skip — leave blank (optional only) or Negotiable / Thỏa thuận (salary). */
export function answerQuestion(core: EngineCore, taskId: number, input: AnswerInput): { resumed: boolean; next: PendingQuestion | null } {
  const result = core.db.transaction((tx) => {
    const task = getTask(tx, taskId);
    if (!task) throw notFound("task", taskId);
    if (task.status !== "paused" || !task.pauseReason?.startsWith("needs_answer") || !isApplyPause(task.output)) {
      throw invalidState(`task ${taskId} is not waiting for an answer`);
    }
    const output = task.output;
    const q = output.pendingQuestions.find((x) => x.field === input.field);
    if (!q) throw invalidInput(`task ${taskId} has no question "${input.field}"`);
    const row = actionRowOf(tx, task);
    const out = row?.output as ActionStepOutput | undefined;
    if (!row || !out) throw invalidState(`task ${taskId} has no Apply step`);
    if (out.answers.some((a) => a.field === q.field)) throw invalidState(`"${q.label}" was already answered`);
    const appId = out.applicationId ?? 0;
    const app = getApplication(tx, appId);
    const v = validateBaAnswer(q, input, { formLanguage: formLanguage(tx, app?.jobId ?? 0) });
    if (!v.ok) throw invalidInput(v.error);
    if (input.remember && v.answer.value !== null) saveAnswer(tx, { label: q.label, answer: v.answer.value }, { now: core.now() });
    const answered = { ...out, answers: [...out.answers, v.answer] };
    const { auto, ask } = questionsForBa(core, tx, task, output, answered, app?.jobId ?? 0);
    const answers = [...answered.answers, ...auto];
    const next = ask[0] ?? null;
    if (next) {
      postQuestion(core, tx, task, appId, next);
      updateAction(core, tx, row, { answers, asked: [...out.asked, next.field] });
      return { resumed: false, next };
    }
    updateAction(core, tx, row, { answers }, "answers complete; resuming");
    resumeTaskNow(core, tx, task);
    return { resumed: true, next: null };
  });
  core.bus.flush();
  core.dispatch();
  return result;
}

/**
 * UC-17 / UC-11 e: Ba clicked "Done" after fixing a login or CAPTCHA in Chrome, or confirmed the
 * extra domain Apply reached (added to the token, then a respawn with the wider allowlist).
 */
export function resumePausedTask(core: EngineCore, taskId: number, opts: { confirmDomain?: string | null } = {}): void {
  core.db.transaction((tx) => {
    const task = getTask(tx, taskId);
    if (!task) throw notFound("task", taskId);
    const reason = task.status === "paused" && task.pauseReason ? parsePauseReason(task.pauseReason) : null;
    if (!reason) throw invalidState(`task ${taskId} is not paused`);
    switch (reason.code) {
      case "needs_login":
      case "captcha":
        resumeTaskNow(core, tx, task);
        return;
      case "domain_confirm": {
        const site = (opts.confirmDomain ?? "").trim().toLowerCase();
        if (!site || site !== reason.site) throw invalidInput(`confirm the domain ${reason.site ?? "(unknown)"} to continue`);
        const appId = Number((task.input as Partial<ApplyPromptInput> | null)?.applicationId);
        const approval = latestApprovalForApplication(tx, appId);
        if (!approval) throw invalidState(`application ${appId} has no approval`);
        addApprovalDomain(tx, approval.token, site);
        resumeTaskNow(core, tx, task);
        return;
      }
      case "needs_answer":
        throw invalidState("answer Apply's questions to continue (UC-12)");
      default:
        throw invalidState(`task ${taskId} resumes by itself (${reason.code})`);
    }
  });
  core.bus.flush();
  core.dispatch();
}

// ---------------------------------------------------------------- the record (§9.1)

function relPath(core: EngineCore, path: string | null): string | null {
  return path === null ? null : core.paths.rel(path);
}

/**
 * The record step: the §9.1 record from Apply's result, with the orchestrator's hash of the copy
 * Apply uploaded and the token the spawn used. A refusal (SubmissionRefusedError) moves the
 * application to needs_check with a safety.denied event; the raw result stays on the task.
 */
export function writeRecordStep(core: EngineCore, conn: Conn, ctx: RunCtx, key: string, scope: Scope, actionRow: Step): "done" {
  const out = actionRow.output as ActionStepOutput;
  const task = out.taskId === null ? undefined : getTask(conn, out.taskId);
  const parsed = task?.status === "done" ? ApplyOutputSchema.safeParse(task.output) : null;
  const appId = out.applicationId;
  if (appId === null || !parsed?.success || (out.outcome !== "submitted" && out.outcome !== "needs_check")) {
    openStep(core, conn, ctx, key, scope, "skipped", {
      output: { applicationId: appId ?? 0, recorded: false, status: null, refused: null, error: out.error ?? "no Apply result to record" } satisfies RecordStepOutput,
    });
    return "done";
  }
  if (getSubmissionRecord(conn, appId)?.submission) {
    // Written before a restart (UC-18): the record is immutable; just finish the step.
    openStep(core, conn, ctx, key, scope, "done", { output: { applicationId: appId, recorded: true, status: getApplication(conn, appId)?.status ?? null, refused: null, error: null } });
    return "done";
  }
  const output = parsed.data;
  const app = getApplication(conn, appId)!;
  const job = getJob(conn, app.jobId)!;
  const company = getCompany(conn, job.companyId);
  const uploaded = output.uploadedFile && out.uploaded ? out.uploaded : null;
  const submission = {
    finalUrl: output.finalUrl,
    fields: output.fieldsFilled.map(({ label, name, value, source }) => ({ label, name, value, source })),
    introText: output.introText,
    consentTicked: output.consent?.ticked ?? null,
    consentText: output.consent?.text ?? null,
    uploadedFilename: uploaded?.filename ?? null,
    // §9.1, decision 2: the orchestrator's hash of the file Apply could upload, never the bot's.
    uploadedSha256: uploaded?.sha256 ?? null,
    uploadedPath: uploaded?.path ?? null,
    preSubmitScreenshotPath: relPath(core, output.preSubmitScreenshot),
    confirmationScreenshotPath: relPath(core, output.confirmationScreenshot),
    confirmationText: output.confirmationText,
    approvalToken: latestApprovalForApplication(conn, appId, { usedOnly: true })?.token ?? null,
    submittedAt: core.now().toISOString(),
  };
  const jd = output.jdSnapshot;
  const snapshot = jd
    ? {
        capturedAt: new Date(jd.capturedAt).toISOString(),
        url: jd.url,
        title: jd.title,
        company: jd.company,
        salaryText: jd.salaryText,
        jdText: jd.jdText,
        pageScreenshotPath: relPath(core, jd.pageScreenshot),
      }
    : // Apply captured no snapshot: freeze what Research stored (UC-11 step 5 fallback).
      { url: job.url ?? "", title: job.title, company: company?.name ?? "", salaryText: job.salaryText, jdText: job.jdText ?? "", pageScreenshotPath: null };
  const status = output.status === "submitted" && !app.dryRun ? "submitted" : "needs_check";
  try {
    // recordSubmission runs in its own savepoint: a refusal writes nothing.
    const rec = recordSubmission(conn, { applicationId: appId, status, dryRun: app.dryRun, submission, snapshot }, { now: core.now() });
    emitApplication(core, conn, rec.application);
    openStep(core, conn, ctx, key, scope, "done", {
      output: { applicationId: appId, recorded: true, status: rec.application.status, refused: null, error: null } satisfies RecordStepOutput,
      preview: rec.application.status === "submitted" ? "record saved" : "record saved · needs check",
    });
  } catch (err) {
    if (err instanceof SubmissionRefusedError) {
      const { application } = markSubmissionRefused(conn, { error: err, taskId: task!.id, botName: task!.botName }, { now: core.now() });
      emitApplication(core, conn, application);
      openStep(core, conn, ctx, key, scope, "done", {
        output: { applicationId: appId, recorded: false, status: application.status, refused: err.reason, error: err.message } satisfies RecordStepOutput,
        preview: `record refused (${err.reason}) · needs check`,
      });
    } else {
      // UC-11 step 9: if writing fails, needs_check; the raw ApplyResult stays on the task.
      moveApplication(core, conn, appId, "needs_check", `the submission record could not be written: ${errorMessage(err)}`);
      openStep(core, conn, ctx, key, scope, "done", {
        output: { applicationId: appId, recorded: false, status: getApplication(conn, appId)?.status ?? null, refused: null, error: errorMessage(err) } satisfies RecordStepOutput,
        preview: "record not written · needs check",
      });
    }
  }
  return "done";
}

export { emitApplication, emitTaskPaused };
