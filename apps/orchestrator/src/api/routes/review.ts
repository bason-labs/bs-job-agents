// Review queue and Ba's decisions (UC-07/08/09/10) and his answers to Apply's questions (UC-12).
// Every decision goes through the engine: the application, its single-use token and the Apply task
// are created in one transaction, and the token's value never leaves the orchestrator (S18).
// UC-07 b: Ba confirms a suspected injection on the card (Engine.confirmInjection, audited as
// injection.confirmed) before Approve is allowed. §12: Approve with dryRun fills and screenshots.
import {
  API_ROUTES,
  AnswerQuestionRequestSchema,
  AnswerQuestionResponseSchema,
  ApproveRequestSchema,
  ApproveResponseSchema,
  OkResponseSchema,
  RequestChangesRequestSchema,
  ReviewQueueResponseSchema,
  SkipRequestSchema,
} from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getStep, getTask, type Db } from "../../db/index.js";
import type { ActionStepOutput } from "../../engine/index.js";
import { requireDb, requireEngine, type ApiContext } from "../context.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { idParam, parseWith, respond } from "../http.js";
import { reviewQueue } from "../views/review.js";
import { cardsOf, messagesWithQuestionCards, updateMessageCards } from "../chat/messages.js";

type JobParams = { Params: { jobId: string } };

/** The API always says whether this approval replaced a denied or expired token. */
const ApproveResultSchema = ApproveResponseSchema.extend({ reapproval: z.boolean() });
/** The shared schema would silently drop a mistyped dryRun (turning a dry run into a live one). */
const ApproveBodySchema = ApproveRequestSchema.strict();

/** A CV version id from the card: a positive integer. */
function rowId(raw: string, what: string): number {
  if (!/^[1-9]\d{0,15}$/.test(raw)) throw badRequest(`${what} ${raw} is not a valid id`);
  return Number(raw);
}

/** The question Lead asked Ba last that has no answer yet (the live question card). */
function currentQuestion(db: Db, taskId: number): string | null {
  const task = getTask(db, taskId);
  if (!task) throw notFound(`task ${taskId} not found`);
  const out = task.stepId === null ? null : (getStep(db, task.stepId)?.output as ActionStepOutput | null | undefined);
  if (!out || !Array.isArray(out.asked)) return null;
  const answered = new Set((out.answers ?? []).map((a) => a.field));
  return [...out.asked].reverse().find((f) => !answered.has(f)) ?? null;
}

export function reviewRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get(API_ROUTES.reviewQueue, async () => {
    const db = requireDb(ctx);
    const workflows = ctx.workflows ?? ctx.engine?.deps.workflows;
    if (!workflows) return respond(ReviewQueueResponseSchema, { cards: [] });
    const cards = await reviewQueue(db, { dataDir: ctx.config.dataDir, workflows, now: ctx.now(), warn: (m) => ctx.log.warn(m) });
    return respond(ReviewQueueResponseSchema, { cards });
  });

  app.post<JobParams>(API_ROUTES.reviewApprove, async (req) => {
    const engine = requireEngine(ctx);
    const jobId = idParam(req.params.jobId, "review card for job");
    const body = parseWith(ApproveBodySchema, req.body);
    const r = engine.approve(jobId, {
      cvVersionId: rowId(body.cvVersionId, "CV version"),
      introText: body.introText,
      ...(body.dryRun === true ? { dryRun: true } : {}),
    });
    return respond(ApproveResultSchema, {
      applicationId: r.applicationId === null ? null : String(r.applicationId),
      taskId: r.taskId === null ? null : String(r.taskId),
      approval: r.approval,
      reapproval: r.reapproval,
    });
  });

  app.post<JobParams>(API_ROUTES.reviewRequestChanges, async (req) => {
    const engine = requireEngine(ctx);
    const jobId = idParam(req.params.jobId, "review card for job");
    const { comment } = parseWith(RequestChangesRequestSchema, req.body);
    engine.requestChanges(jobId, comment);
    return respond(OkResponseSchema, { ok: true });
  });

  // UC-07 b: Ba read the flagged JD and confirms it is safe; Apply may then be approved.
  app.post<JobParams>(API_ROUTES.reviewConfirmInjection, async (req) => {
    const engine = requireEngine(ctx);
    engine.confirmInjection(idParam(req.params.jobId, "job"));
    return respond(OkResponseSchema, { ok: true });
  });

  app.post<JobParams>(API_ROUTES.reviewSkip, async (req) => {
    const engine = requireEngine(ctx);
    const jobId = idParam(req.params.jobId, "review card for job");
    engine.skip(jobId, parseWith(SkipRequestSchema, req.body));
    return respond(OkResponseSchema, { ok: true });
  });

  app.post<{ Params: { taskId: string } }>(API_ROUTES.answerQuestion, async (req) => {
    const engine = requireEngine(ctx);
    const taskId = idParam(req.params.taskId, "task");
    const body = parseWith(AnswerQuestionRequestSchema, req.body);
    const field = body.field ?? currentQuestion(engine.db, taskId);
    if (field === null) {
      if (!getTask(engine.db, taskId)) throw notFound(`task ${taskId} not found`);
      throw conflict(`task ${taskId} is not waiting for an answer`);
    }
    const r = engine.answerQuestion(taskId, { field, mode: body.mode, value: body.value, remember: body.remember });
    markQuestionAnswered(engine.db, taskId, field);
    return respond(AnswerQuestionResponseSchema, r);
  });
}

/** The question card for `field` turns answered, so a reloaded chat shows it settled (UC-12). */
function markQuestionAnswered(db: Db, taskId: number, field: string): void {
  db.transaction((tx) => {
    for (const message of messagesWithQuestionCards(tx, taskId)) {
      const cards = cardsOf(message);
      const next = cards.map((c) => (c.type === "question" && c.taskId === String(taskId) && c.question.field === field ? { ...c, answered: true } : c));
      if (JSON.stringify(next) !== JSON.stringify(cards)) updateMessageCards(tx, message, next);
    }
  });
}
