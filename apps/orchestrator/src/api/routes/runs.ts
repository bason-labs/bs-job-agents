// Runs, steps and tasks (UC-01 start, UC-22 inspect, UC-23 pause/cancel/re-run, UC-17 resume).
// Reads come from the db; every command goes through the engine, so its events and audit rows
// are written.
import {
  API_ROUTES,
  OkResponseSchema,
  RunControlRequestSchema,
  RunControlResponseSchema,
  RunDetailSchema,
  RunSchema,
  RunsQuerySchema,
  RunsResponseSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
  StepDetailSchema,
  StepSchema,
  TaskResumeRequestSchema,
  TaskSchema,
  type Task as SharedTask,
} from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { getRun, getStep, getUpload, listRuns, listSteps, listTasks, mappers, type Task } from "../../db/index.js";
import { requireDb, requireEngine, type ApiContext } from "../context.js";
import { badRequest, notFound } from "../errors.js";
import { safeDataPath } from "../files.js";
import { idParam, keepValid, parseWith, respond } from "../http.js";
import { runDefinition, stepPreviews } from "../views/runs.js";

type IdParams = { Params: { id: string } };

/** A task as the UI sees it: the transcript path only when it stays inside data/. */
export function toApiTask(row: Task): SharedTask {
  const task = mappers.toTask(row);
  return { ...task, transcriptPath: safeDataPath(task.transcriptPath) };
}

interface SelfCheckItem {
  item: string;
  passed: boolean;
  note: string | null;
}

/** The latest task's `selfCheck` (rule 4), item by item; anything malformed is left out. */
function selfCheckOf(output: unknown): SelfCheckItem[] {
  const list = (output as { selfCheck?: unknown } | null)?.selfCheck;
  if (!Array.isArray(list)) return [];
  return list.flatMap((c: unknown) => {
    const x = c as Partial<SelfCheckItem> | null;
    if (!x || typeof x.item !== "string" || typeof x.passed !== "boolean") return [];
    return [{ item: x.item, passed: x.passed, note: typeof x.note === "string" ? x.note : null }];
  });
}

export function runRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const warn = (m: string) => ctx.log.warn(m);

  app.get(API_ROUTES.runs, async (req) => {
    const db = requireDb(ctx);
    const q = parseWith(RunsQuerySchema, req.query);
    const rows = listRuns(db, { ...(q.status ? { status: q.status } : {}), limit: q.limit });
    return respond(RunsResponseSchema, { runs: keepValid(RunSchema, rows.map(mappers.toRun), warn) });
  });

  app.post(API_ROUTES.runs, async (req, reply) => {
    const engine = requireEngine(ctx);
    const input = parseWith(StartRunRequestSchema, req.body);
    // The engine would only find out when it builds Research's task, after the run exists.
    if (input.workflow === "apply-to-file") {
      const id = Number(input.params.uploadId);
      if (!Number.isSafeInteger(id) || !getUpload(engine.db, id)) throw badRequest(`params.uploadId: upload ${input.params.uploadId} not found`);
    }
    // A pasted link starts apply-to-link with the link trigger (UC-14); the rest come from chat.
    const run = engine.startWorkflow(input, { trigger: input.workflow === "apply-to-link" ? "link" : "chat" });
    void reply.code(201);
    return respond(StartRunResponseSchema, { runId: String(run.id) });
  });

  app.get<IdParams>(API_ROUTES.run, async (req) => {
    const db = requireDb(ctx);
    const id = idParam(req.params.id, "run");
    const run = getRun(db, id);
    if (!run) throw notFound(`run ${id} not found`);
    const stepRows = listSteps(db, id);
    const taskRows = listTasks(db, { runId: id });
    return respond(RunDetailSchema, {
      run: mappers.toRun(run),
      steps: keepValid(StepSchema, stepRows.map(mappers.toStep), warn),
      tasks: keepValid(TaskSchema, taskRows.map(toApiTask), warn),
      definition: runDefinition(ctx.workflows ?? ctx.engine?.deps.workflows, run.workflowName, run.workflowVersion),
      previews: stepPreviews(db, id, stepRows, taskRows),
    });
  });

  app.post<IdParams>(API_ROUTES.runControl, async (req) => {
    const engine = requireEngine(ctx);
    const id = idParam(req.params.id, "run");
    const { action } = parseWith(RunControlRequestSchema, req.body);
    let aborted: number[] = [];
    if (action === "pause") engine.pauseRun(id);
    else if (action === "resume") engine.resumeRun(id);
    else aborted = engine.cancelRun(id);
    const run = getRun(engine.db, id);
    if (!run) throw notFound(`run ${id} not found`);
    return respond(RunControlResponseSchema, { run: mappers.toRun(run), abortedTaskIds: aborted.map(String) });
  });

  app.get<IdParams>(API_ROUTES.step, async (req) => {
    const db = requireDb(ctx);
    const id = idParam(req.params.id, "step");
    const step = getStep(db, id);
    if (!step) throw notFound(`step ${id} not found`);
    const tasks = listTasks(db, { stepId: id });
    const started = step.startedAt ? Date.parse(step.startedAt) : NaN;
    const ended = step.finishedAt ? Date.parse(step.finishedAt) : ctx.now().getTime();
    return respond(StepDetailSchema, {
      step: mappers.toStep(step),
      tasks: keepValid(TaskSchema, tasks.map(toApiTask), warn),
      selfCheck: selfCheckOf(tasks.at(-1)?.output),
      durationMs: Number.isFinite(started) ? Math.max(0, ended - started) : null,
    });
  });

  app.post<IdParams>(API_ROUTES.stepRerun, async (req) => {
    const engine = requireEngine(ctx);
    engine.rerunStep(idParam(req.params.id, "step"));
    return respond(OkResponseSchema, { ok: true });
  });

  app.post<IdParams>(API_ROUTES.taskResume, async (req) => {
    const engine = requireEngine(ctx);
    const id = idParam(req.params.id, "task");
    const { confirmDomain } = parseWith(TaskResumeRequestSchema, req.body ?? {});
    engine.resumeTask(id, { confirmDomain });
    return respond(OkResponseSchema, { ok: true });
  });

  // UC-11 e "Don't allow": Ba declines the site Apply paused at; Apply ends (needs_check), the
  // token keeps its domains, and a safety event is logged (engine.declineDomain, F3).
  app.post<IdParams>(API_ROUTES.taskDeclineDomain, async (req) => {
    const engine = requireEngine(ctx);
    engine.declineDomain(idParam(req.params.id, "task"));
    return respond(OkResponseSchema, { ok: true });
  });
}
