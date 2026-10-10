// Review queue and Ba's decisions (UC-07/08/09/10) and his answers to Apply's questions (UC-12).
// Every decision goes through the engine: the application, its single-use token and the Apply task
// are created in one transaction, and the token's value never leaves the orchestrator (S18).
// UC-07 b's confirm-injection waits for F2's audited Engine.confirmInjection (W3a part 2).
import {
  API_ROUTES,
  AnswerQuestionRequestSchema,
  AnswerQuestionResponseSchema,
  ApproveRequestSchema,
  ApproveResponseSchema,
  IdSchema,
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

type JobParams = { Params: { jobId: string } };

/**
 * The approve response today: the engine returns no application for an uploaded JD without an
 * apply link (§7.3b), and says when this approval replaced a denied or expired token. F2 makes
 * the shared ApproveResponseSchema's applicationId nullable; W3a part 2 then uses it as is.
 */
const ApproveResultSchema = ApproveResponseSchema.extend({ applicationId: IdSchema.nullable(), reapproval: z.boolean() });

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
    // The shared schema would drop an unknown `dryRun`, turning a dry run into a live submit. Until
    // the dry-run approval lands (W3a part 2, with F2's schema), it is refused instead.
    if ((req.body as { dryRun?: unknown } | null | undefined)?.dryRun === true) {
      throw badRequest("dry run approvals are not available yet; nothing was approved");
    }
    const body = parseWith(ApproveRequestSchema, req.body);
    const r = engine.approve(jobId, { cvVersionId: rowId(body.cvVersionId, "CV version"), introText: body.introText });
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
    return respond(AnswerQuestionResponseSchema, r);
  });
}
