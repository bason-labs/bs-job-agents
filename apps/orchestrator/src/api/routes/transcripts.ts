// UC-22: GET /tasks/:id/transcript — a task attempt's transcript for the step drawer, summarised,
// redacted and size-capped (see ../transcripts.ts). 404 when the task has no transcript (yet).
import { API_ROUTES, TranscriptQuerySchema, TranscriptResponseSchema } from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { getTask, schema } from "../../db/index.js";
import { requireDb, type ApiContext } from "../context.js";
import { notFound } from "../errors.js";
import { idParam, parseWith, respond } from "../http.js";
import { readTranscript, transcriptAttempts } from "../transcripts.js";

export function transcriptRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get<{ Params: { id: string } }>(API_ROUTES.taskTranscript, async (req) => {
    const db = requireDb(ctx);
    const taskId = idParam(req.params.id, "task");
    const task = getTask(db, taskId);
    if (!task) throw notFound(`task ${taskId} not found`);
    const q = parseWith(TranscriptQuerySchema, req.query);
    const attempts = transcriptAttempts(ctx.config.dataDir, taskId, Math.max(task.attempt, q.attempt ?? 0));
    const attempt = q.attempt ?? attempts.at(-1);
    if (attempt === undefined || !attempts.includes(attempt)) throw notFound(`task ${taskId} has no transcript${q.attempt ? ` for attempt ${q.attempt}` : ""} yet`);
    const tokens = db.select({ token: schema.approvals.token }).from(schema.approvals).all().map((r) => r.token);
    const read = readTranscript(join(ctx.config.dataDir, "transcripts", `${taskId}-${attempt}.jsonl`), { after: q.after, tokens });
    return respond(TranscriptResponseSchema, {
      taskId: String(taskId),
      attempt,
      attempts,
      lines: read.lines,
      nextAfter: read.nextAfter,
      truncated: read.truncated,
      running: task.status === "running" && attempt === task.attempt,
    });
  });
}
