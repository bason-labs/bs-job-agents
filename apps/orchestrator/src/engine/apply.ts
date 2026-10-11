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
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  ApplyPromptInputSchema,
  BOT_TASK_INPUT_SCHEMAS,
  canTransitionApplicationStatus,
  normalizeAnswerKey,
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
  flagJobInjection,
  getApplication,
  getCompany,
  getCvVersion,
  getJob,
  getOrCreateLeadRoom,
  getStep,
  getSubmissionRecord,
  getTask,
  latestApprovalForApplication,
  listMessages,
  listSavedAnswers,
  mappers,
  markSubmissionRefused,
  recordSubmission,
  saveAnswer,
  setMessageCards,
  transitionApplication,
  updateTaskInput,
  type Application,
  type Approval,
  type Conn,
  type Step,
  type Task,
} from "../db/index.js";
import type { CapturedScreenshot } from "../runner/screenshots.js";
import { formDefaultsOf, loadRunCtx, type RunCtx, type Scope } from "./context.js";
import { noticeApplyNotStarted, noticeNeedsCheck } from "./notices.js";
import { siteKey } from "./sites.js";
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

/**
 * System change of an application in the apply flow, if the shared status machine allows it. A move
 * to needs_check is reported to Ba in the same transaction (S1).
 */
export function moveApplication(
  core: EngineCore,
  conn: Conn,
  applicationId: number,
  to: Application["status"],
  note: string,
  opts: { runId?: number | null } = {},
): Application | null {
  const app = getApplication(conn, applicationId);
  if (!app || app.status === to || !canTransitionApplicationStatus(app.status, to, "system", { dryRun: app.dryRun })) return null;
  const moved = transitionApplication(conn, app.id, to, { now: core.now(), note });
  emitApplication(core, conn, moved);
  if (to === "needs_check") noticeNeedsCheck(core, conn, app.id, note, opts);
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
    // A bad row (empty key or label) must never make every Apply input invalid.
    savedAnswers: listSavedAnswers(conn)
      .filter((s) => s.key.trim() !== "" && s.label.trim() !== "")
      .map((s) => ({ key: s.key, label: s.label, answer: s.answer })),
    answers: args.answers,
    formDefaults: { salaryPolicy: defaults.salaryPolicy, salaryAmount: defaults.salaryAmount, currency: defaults.currency },
    dryRun: app.dryRun,
  });
}

// ---------------------------------------------------------------- before the spawn

export type ApplyPrep =
  | {
      kind: "ready";
      /** The prompt input, already validated (no token). */
      input: ApplyPromptInput;
      readDir: string;
      allowedSites: string[];
      /**
       * The last step before runner.run, with nothing fallible after it: consume the token (first
       * spawn) or re-validate it (resume), store the prompt input and the uploaded copy, in one
       * transaction. Null = denied (the task failed with a safety event; nothing may spawn).
       */
      authorize(): ApplyPromptInput | null;
    }
  | { kind: "stopped" };

type SafetyReason = Parameters<typeof emitSafetyDenied>[2]["reason"];

/**
 * Apply stopped before it spawned (token denied, bot refused, an engine error), so nothing ran in
 * this attempt and the task has failed. The card waits for Ba to approve again — unless an
 * earlier spawn already used a token that is still valid (a resume): no new token can be issued
 * then, and that spawn may have filled part of the form, so the application needs a check.
 */
export function applyStoppedBeforeSpawn(core: EngineCore, conn: Conn, task: Task, outcome: "denied" | "not_started", error: string): void {
  const row = actionRowOf(conn, task);
  const appId = Number((task.input as Partial<ApplyPromptInput> | null)?.applicationId);
  if (isApplyPause(task.output) && Number.isInteger(appId)) {
    const latest = latestApprovalForApplication(conn, appId);
    if (latest && latest.usedAt !== null && latest.expiresAt > core.now().toISOString()) {
      moveApplication(core, conn, appId, "needs_check", `Apply could not continue: ${error}`, { runId: task.runId });
      if (row) updateAction(core, conn, row, { outcome: "needs_check", error });
      return;
    }
  }
  if (row) updateAction(core, conn, row, { outcome, error });
  // S1: the card waits for Ba to approve again (a new token) or skip.
  noticeApplyNotStarted(core, conn, task, error);
}

/** Refused by the trust guard before anything ran (inside `conn`'s transaction). */
function denyIn(core: EngineCore, conn: Conn, task: Task, reason: SafetyReason, detail: string): void {
  failTaskNow(core, conn, task, `denied: ${detail}`);
  emitSafetyDenied(core, conn, { botName: task.botName, taskId: task.id, action: "apply.submit", reason, detail });
  applyStoppedBeforeSpawn(core, conn, task, "denied", detail);
}

function deny(core: EngineCore, task: Task, reason: SafetyReason, detail: string): ApplyPrep {
  core.db.transaction((tx) => denyIn(core, tx, task, reason, detail));
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
    noticeNeedsCheck(core, tx, application.id, detail, { runId: task.runId });
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

  // Build and check the prompt input before the token is touched.
  let prompt: ApplyPromptInput;
  try {
    prompt = db.transaction((tx) =>
      buildApplyPromptInput(core, tx, task.runId === null ? null : loadRunCtx(core, task.runId, tx), {
        application: app,
        approval: pre.approval,
        introText: stored.introText ?? null,
        answers: (actionRowOf(tx, task)?.output as ActionStepOutput | null)?.answers ?? [],
      }),
    );
  } catch (err) {
    const error = `could not build Apply's input: ${errorMessage(err)}`;
    db.transaction((tx) => {
      failTaskNow(core, tx, task, error);
      applyStoppedBeforeSpawn(core, tx, task, "not_started", error);
    });
    return { kind: "stopped" };
  }
  const uploaded = { filename: basename(fileRel), path: fileRel, sha256 };
  return {
    kind: "ready",
    input: prompt,
    readDir: core.paths.abs(dirRel),
    allowedSites: pre.approval.allowedDomains,
    authorize: () =>
      db.transaction((tx) => {
        const auth = authorizeApplyToken(tx, { ...req, now: core.now() });
        if (!auth.ok) {
          denyIn(core, tx, task, auth.reason, auth.detail);
          return null;
        }
        // Validate the full input (with the token), then keep only the prompt part (PM S5).
        const full = BOT_TASK_INPUT_SCHEMAS["apply.submit"].parse({ ...prompt, allowedDomains: auth.approval.allowedDomains, approvalToken: auth.approval.token });
        const input = splitApplySubmitInput(full).prompt;
        updateTaskInput(tx, task.id, input);
        const row = actionRowOf(tx, task);
        if (row) updateAction(core, tx, row, { uploaded }, auth.mode === "resume" ? "resuming" : "applying");
        moveApplication(core, tx, app.id, "approved", "Apply resumed");
        return input;
      }),
  };
}

// ---------------------------------------------------------------- after the spawn

/**
 * Apply reported submitted or needs_check. The §9.1 record is written right here, in the same
 * transaction as the task's result, whatever the run's state (a paused or cancelled run must not
 * lose a submission). A dry run that says submitted is a safety event (PM §7).
 */
export function onApplyDone(core: EngineCore, conn: Conn, task: Task, output: ApplyOutput, files: RecordFiles = NO_RECORD_FILES, check: string | null = null): void {
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
  if (!row || !out || out.applicationId === null) return;
  const record = writeSubmissionRecord(core, conn, task, output, out, files, check);
  updateAction(core, conn, row, { outcome: record.status === "submitted" ? "submitted" : "needs_check", record });
}

/** PM2 S11: Apply reported an injection on the job's page: flag the job (Apply stays off until Ba confirms). */
export function flagApplyJob(conn: Conn, task: Task): void {
  const app = getApplication(conn, Number((task.input as Partial<ApplyPromptInput> | null)?.applicationId));
  if (app) flagJobInjection(conn, app.jobId);
}

/** After a spawn, anything but a clean result or a pause: needs_check, never retried (UC-11 c, PM FYI c). */
export function onApplyFailedAfterSpawn(core: EngineCore, conn: Conn, task: Task, error: string): void {
  const row = actionRowOf(conn, task);
  const appId = Number((task.input as Partial<ApplyPromptInput> | null)?.applicationId);
  if (Number.isInteger(appId)) moveApplication(core, conn, appId, "needs_check", `Apply did not finish cleanly: ${error}`, { runId: task.runId });
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
 * W3a request (UC-12): the question card turns answered with Ba's answer (null = left blank), in
 * the answer's transaction (no event: the message is not new; the API's answer response tells the UI).
 */
function settleQuestionCard(core: EngineCore, conn: Conn, taskId: number, field: string, answer: string | null): void {
  const room = getOrCreateLeadRoom(conn, { now: core.now() });
  for (const message of listMessages(conn, room.id)) {
    const cards = (message.meta?.cards as Array<Record<string, unknown>> | undefined) ?? [];
    let changed = false;
    const next = cards.map((c) => {
      if (c.type !== "question" || c.taskId !== String(taskId) || (c.question as { field?: unknown } | null)?.field !== field) return c;
      changed = true;
      return { ...c, answered: true, answer };
    });
    if (!changed) continue;
    setMessageCards(conn, message.id, next);
  }
}

/** Apply may resume without Ba at most this often per task (each time with new automatic answers). */
export const MAX_AUTO_RESUMES = 3;

/**
 * Apply paused itself (UC-11 a/b/e, UC-12, UC-17): the application waits as `paused`.
 * - Pending questions are answered from saved answers and the form defaults where they decide;
 *   Lead asks Ba the rest, one at a time.
 * - Apply resumes without Ba only for questions (needs_answer), only when this pause produced new
 *   automatic answers and nothing is left for Ba, and at most MAX_AUTO_RESUMES times. A login, a
 *   CAPTCHA or a domain to confirm always waits for Ba (PM FYI c).
 * - A question Apply asks again although it has an answer (the form rejected it) goes to Ba.
 */
export function onApplyPaused(core: EngineCore, conn: Conn, task: Task, output: ApplyOutput): void {
  const row = actionRowOf(conn, task);
  const out = (row?.output as ActionStepOutput | undefined) ?? null;
  const appId = Number((task.input as Partial<ApplyPromptInput> | null)?.applicationId);
  moveApplication(core, conn, appId, "paused", output.pauseReason?.detail ?? output.pauseReason?.reason ?? "pending questions");
  if (!row || !out) return;
  const reason = output.pauseReason?.reason ?? "needs_answer";
  if (reason === "needs_answer" && output.pendingQuestions.length === 0) {
    // Nothing to answer and nothing Ba can do in the app: Ba checks the form by hand.
    const error = "Apply paused for answers but listed no question";
    failTaskNow(core, conn, getTask(conn, task.id)!, error);
    onApplyFailedAfterSpawn(core, conn, task, error);
    return;
  }
  const reAsked = new Set(output.pendingQuestions.filter((q) => out.answers.some((a) => a.field === q.field)).map((q) => q.field));
  const kept = out.answers.filter((a) => !reAsked.has(a.field));
  const asked = out.asked.filter((f) => !reAsked.has(f));
  const app = getApplication(conn, appId);
  const qctx = questionContext(core, conn, task, app?.jobId ?? 0);
  const autoResumes = out.autoResumes ?? 0;
  const capped = autoResumes >= MAX_AUTO_RESUMES;
  const auto: QuestionAnswer[] = [];
  const ask: PendingQuestion[] = [];
  for (const q of output.pendingQuestions) {
    // Re-asked questions, and every question once the automatic resumes are used up, go to Ba.
    const r = reAsked.has(q.field) || capped ? null : resolvePendingQuestion(q, qctx);
    if (r && r.kind !== "ask") auto.push(r.answer);
    else ask.push(q);
  }
  const answers = [...kept, ...auto];
  if (reason === "needs_answer" && ask.length === 0 && auto.length > 0) {
    updateAction(core, conn, row, { answers, asked, autoResumes: autoResumes + 1 });
    resumeTaskNow(core, conn, getTask(conn, task.id)!);
    return;
  }
  const next = ask.find((q) => !asked.includes(q.field));
  if (next) postQuestion(core, conn, task, appId, next);
  updateAction(core, conn, row, { answers, asked: next ? [...asked, next.field] : asked }, "waiting for Ba");
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
    // "Remember this answer": only under a label that means something once normalised.
    if (input.remember && v.answer.value !== null && normalizeAnswerKey(q.label) !== "") {
      saveAnswer(tx, { label: q.label, answer: v.answer.value }, { now: core.now() });
    }
    settleQuestionCard(core, tx, task.id, q.field, v.answer.value);
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
        // PM2 M2: the pause names the host the site guard blocked; compare the way hosts are compared.
        const site = siteKey(opts.confirmDomain ?? "");
        if (!site || !reason.site || site !== siteKey(reason.site)) throw invalidInput(`confirm the domain ${reason.site ?? "(unknown)"} to continue`);
        const appId = Number((task.input as Partial<ApplyPromptInput> | null)?.applicationId);
        const approval = latestApprovalForApplication(tx, appId);
        if (!approval) throw invalidState(`application ${appId} has no approval`);
        // The exact host offered (the one the guard blocked), never Ba's typed variant of it.
        addApprovalDomain(tx, approval.token, reason.site);
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

/**
 * UC-11 e, "Don't allow" (W3a request): Ba declines the domain Apply paused for. The token is not
 * widened; Apply ends without a retry, and because it already filled part of the form the
 * application needs a check (UC-11 c). Logged as safety.denied(off_allowlist); Lead's needs_check
 * notice goes out with the move. Not a demotion: Apply did pause for Ba as it should.
 */
export function declineDomain(core: EngineCore, taskId: number): void {
  core.db.transaction((tx) => {
    const task = getTask(tx, taskId);
    if (!task) throw notFound("task", taskId);
    const reason = task.status === "paused" && task.pauseReason ? parsePauseReason(task.pauseReason) : null;
    if (reason?.code !== "domain_confirm") throw invalidState(`task ${taskId} is not waiting for a domain to confirm`);
    const site = reason.site ?? "the new site";
    const error = `Ba declined ${site}; Apply stopped there (UC-11 e)`;
    failTaskNow(core, tx, task, error);
    emitSafetyDenied(core, tx, { botName: task.botName, taskId: task.id, action: "apply.domain_confirm", reason: "off_allowlist", detail: `Ba did not allow ${site} for this application` });
    onApplyFailedAfterSpawn(core, tx, task, error);
  });
  core.bus.flush();
  core.advance(getTask(core.db, taskId)?.runId ?? null);
  core.dispatch();
}

// ---------------------------------------------------------------- the record (§9.1)

/** The screenshots the record may cite: data/-relative paths of verified files, or null (PM2 M1). */
export interface RecordFiles {
  preSubmit: string | null;
  confirmation: string | null;
  jdPage: string | null;
}

export const NO_RECORD_FILES: RecordFiles = { preSubmit: null, confirmation: null, jdPage: null };

/** PNG (89 50 4E 47 0D 0A 1A 0A) or JPEG (FF D8 FF). */
function isImage(head: Buffer): boolean {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (head.length >= png.length && png.every((b, i) => head[i] === b)) return true;
  return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

/**
 * PM2 M1: a screenshot path from Apply's output (untrusted) as the record may cite it: resolved
 * inside data/applications/<id>/ (relative names resolve there; nothing may leave it), an existing
 * regular file (links are not followed) and a PNG or JPEG. Anything else is null: the record never
 * cites a path the bot named, only the files the orchestrator put in the application's folder.
 */
async function recordFile(core: EngineCore, applicationId: number, value: string | null | undefined): Promise<string | null> {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) return null;
  const dir = resolve(core.paths.abs(core.paths.applicationDir(applicationId)));
  const abs = isAbsolute(value) ? resolve(value) : resolve(dir, value);
  const inside = relative(dir, abs);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
  const head = await core.deps.files.readHead(abs, 8, dir).catch(() => null);
  return head && isImage(head) ? core.paths.rel(abs) : null;
}

/** PM2 S7: the screenshot Apply named, by the id the Chrome tool showed it (exactly, or as the one id its text names). */
export function pickCapture(value: string | null | undefined, captures: readonly CapturedScreenshot[]): CapturedScreenshot | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const v = value.trim();
  const exact = captures.filter((c) => c.screenshotId === v);
  if (exact.length > 0) return exact.at(-1)!;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = captures.filter((c) => c.screenshotId !== null && new RegExp(`(?:^|[^A-Za-z0-9_-])${esc(c.screenshotId)}(?:$|[^A-Za-z0-9_-])`).test(v));
  const ids = new Set(named.map((c) => c.screenshotId));
  return ids.size === 1 ? named.at(-1)! : null;
}

/** Where an attempt's captures are: data/screenshots/<task>-<attempt>/ and what the runner listed. */
export interface CaptureSource {
  /** Absolute folder. */
  dir: string;
  captures: CapturedScreenshot[];
}

/**
 * PM2 S7 + M1: the record's screenshots. Apply names a screenshot by the id the tool showed; the
 * capture it names is copied (hash-checked against what the runner wrote) into
 * data/applications/<id>/ as pre-submit / confirmation / jd, and only that copy passes M1's check.
 * A name that is no capture (a path, prose, a file Apply claims to have saved) is null. One capture
 * is one proof: named as both the pre-submit and the confirmation screenshot it counts once.
 * Runs before the record's transaction (the FileStore is async).
 */
export async function captureRecordFiles(core: EngineCore, applicationId: number, output: ApplyOutput, source: CaptureSource | null): Promise<RecordFiles> {
  const captures = source?.captures ?? [];
  const pre = pickCapture(output.preSubmitScreenshot, captures);
  const conf = pickCapture(output.confirmationScreenshot, captures);
  const jd = pickCapture(output.jdSnapshot?.pageScreenshot, captures);
  const copy = async (c: CapturedScreenshot | null, name: string): Promise<string | null> => {
    if (!c || !source) return null;
    const dest = `${core.paths.applicationDir(applicationId)}/${name}.${c.mediaType === "image/png" ? "png" : "jpg"}`;
    try {
      await core.deps.files.copyVerified(join(source.dir, c.file), core.paths.abs(dest), c.sha256);
    } catch {
      return null;
    }
    return recordFile(core, applicationId, core.paths.abs(dest));
  };
  return {
    preSubmit: await copy(pre, "pre-submit"),
    confirmation: conf !== null && conf.file === pre?.file ? null : await copy(conf, "confirmation"),
    jdPage: await copy(jd, "jd"),
  };
}

/** The status-history note when Apply said submitted but its proof is not on disk (PM2 M1). */
export const SCREENSHOTS_NOT_CAPTURED = "screenshots not captured";

/** The status-history note when Apply reported an injection attempt on the page (PM2 S11). */
export const INJECTION_SUSPECTED = "injection suspected";

/**
 * §9.1 / UC-11 step 9: the record from Apply's result, written right after Apply reported it,
 * with the orchestrator's hash of the copy Apply uploaded and the token the spawn used. When
 * Apply reports another file than that copy, the record keeps the copy and the application needs
 * a check (the raw report stays on the task). A refusal (SubmissionRefusedError) moves the
 * application to needs_check with a safety.denied event; any other failure to write: needs_check.
 * PM2 M1: the screenshots are the verified `files` only; `submitted` without a pre-submit
 * screenshot, or without both a confirmation screenshot and text, is needs_check
 * ("screenshots not captured"), never clean.
 */
export function writeSubmissionRecord(
  core: EngineCore,
  conn: Conn,
  task: Task,
  output: ApplyOutput,
  out: ActionStepOutput,
  files: RecordFiles = NO_RECORD_FILES,
  /** PM2 S10: the engine's own reason this record needs Ba's check (e.g. the tab left the approved domains). */
  check: string | null = null,
): RecordStepOutput {
  const appId = out.applicationId!;
  if (getSubmissionRecord(conn, appId)?.submission) {
    return { applicationId: appId, recorded: true, status: getApplication(conn, appId)?.status ?? null, refused: null, error: null };
  }
  const app = getApplication(conn, appId)!;
  const job = getJob(conn, app.jobId)!;
  const company = getCompany(conn, job.companyId);
  const uploaded = output.uploadedFile && out.uploaded ? out.uploaded : null;
  const sameFile = !output.uploadedFile || !uploaded || (output.uploadedFile.filename === uploaded.filename && output.uploadedFile.sha256 === uploaded.sha256);
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
    preSubmitScreenshotPath: files.preSubmit,
    confirmationScreenshotPath: files.confirmation !== files.preSubmit ? files.confirmation : null,
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
        pageScreenshotPath: files.jdPage,
      }
    : // Apply captured no snapshot: freeze what Research stored (UC-11 step 5 fallback).
      { url: job.url ?? "", title: job.title, company: company?.name ?? "", salaryText: job.salaryText, jdText: job.jdText ?? "", pageScreenshotPath: null };
  // One file is one proof: a confirmation screenshot that is the pre-submit one does not count; blank text is no text.
  const confirmation = files.confirmation !== null && files.confirmation !== files.preSubmit ? files.confirmation : null;
  const proofMissing = files.preSubmit === null || (confirmation === null && !output.confirmationText?.trim());
  // PM2 S11: a page that tried to instruct Apply means Ba checks what was sent.
  const injection = output.injectionSuspected === true;
  const status = output.status === "submitted" && !app.dryRun && sameFile && !proofMissing && !injection && check === null ? "submitted" : "needs_check";
  const note = injection
    ? `${INJECTION_SUSPECTED}: ${output.injectionNote?.trim() || "the page tried to instruct Apply"}`
    : check !== null
      ? check
      : output.status === "submitted" && !app.dryRun && proofMissing
        ? SCREENSHOTS_NOT_CAPTURED
        : null;
  try {
    // recordSubmission runs in its own savepoint: a refusal writes nothing.
    const rec = recordSubmission(conn, { applicationId: appId, status, dryRun: app.dryRun, submission, snapshot, note }, { now: core.now() });
    emitApplication(core, conn, rec.application);
    if (rec.application.status === "needs_check") {
      // S1: why the record needs Ba's check (a dry run reports its own way).
      const why =
        note ??
        (!sameFile
          ? `Apply reported uploading ${output.uploadedFile!.filename}, not the approved copy`
          : output.status === "submitted"
            ? "it needs a look before it counts as submitted"
            : "Apply could not confirm the submission");
      const dryRun = app.dryRun ? (output.status === "submitted" ? "reported_submitted" : "finished") : undefined;
      noticeNeedsCheck(core, conn, appId, why, { runId: task.runId, ...(dryRun ? { dryRun } : {}) });
    }
    return { applicationId: appId, recorded: true, status: rec.application.status, refused: null, error: sameFile ? null : `Apply reported uploading ${output.uploadedFile!.filename}` };
  } catch (err) {
    if (err instanceof SubmissionRefusedError) {
      const { application } = markSubmissionRefused(conn, { error: err, taskId: task.id, botName: task.botName }, { now: core.now() });
      emitApplication(core, conn, application);
      noticeNeedsCheck(core, conn, appId, `the submission record was refused (${err.reason})`, { runId: task.runId });
      return { applicationId: appId, recorded: false, status: application.status, refused: err.reason, error: err.message };
    }
    // UC-11 step 9: if writing fails, needs_check; the raw ApplyResult stays on the task.
    moveApplication(core, conn, appId, "needs_check", `the submission record could not be written: ${errorMessage(err)}`, { runId: task.runId });
    return { applicationId: appId, recorded: false, status: getApplication(conn, appId)?.status ?? null, refused: null, error: errorMessage(err) };
  }
}

/** The record step (§7.2 step 10): reports the record written when Apply's result came in. */
export function writeRecordStep(core: EngineCore, conn: Conn, ctx: RunCtx, key: string, scope: Scope, actionRow: Step): "done" {
  const out = actionRow.output as ActionStepOutput;
  const record = out.record ?? null;
  if (!record) {
    openStep(core, conn, ctx, key, scope, "skipped", {
      output: { applicationId: out.applicationId ?? 0, recorded: false, status: null, refused: null, error: out.error ?? "no Apply result to record" } satisfies RecordStepOutput,
    });
    return "done";
  }
  const preview = record.recorded
    ? record.status === "submitted"
      ? "record saved"
      : "record saved · needs check"
    : record.refused
      ? `record refused (${record.refused}) · needs check`
      : "record not written · needs check";
  openStep(core, conn, ctx, key, scope, "done", { output: record, preview });
  return "done";
}

export { emitApplication, emitTaskPaused };
