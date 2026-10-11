// Schedules (UC-21, §7.4, PM S23): create, edit, enable/disable, soft delete with a 6 s Undo, and
// Run now. The scheduler only fills next_run_at when it is null, so every create and edit computes
// it here (disabled: null). A schedule starts its workflow with the schedule trigger, so only a
// workflow that allows it can be scheduled, and its params must make a valid start input.
import {
  API_ROUTES,
  ScheduleCreateRequestSchema,
  ScheduleDeleteResponseSchema,
  ScheduleRunNowResponseSchema,
  ScheduleUpdateRequestSchema,
  ScheduleViewSchema,
  SchedulesResponseSchema,
  StartWorkflowInputSchema,
  type ScheduleView,
} from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import {
  UNDO_WINDOW_MS,
  createSchedule,
  getRun,
  getSchedule,
  getSearchProfile,
  listEvents,
  listSchedules,
  listSteps,
  mappers,
  purgeDeletedSchedules,
  restoreSchedule,
  softDeleteSchedule,
  updateSchedule,
  type Conn,
  type Db,
  type JsonObject,
  type Schedule,
} from "../../db/index.js";
import { computeNextRunAt, type WorkflowSource } from "../../engine/index.js";
import { requireDb, requireEngine, type ApiContext } from "../context.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { idParam, keepValid, parseWith, respond } from "../http.js";

type IdParams = { Params: { id: string } };

export interface ScheduleFields {
  cron: string;
  timezone: string;
  workflowName: string;
  searchProfileId: number | null;
  params: JsonObject;
  enabled: boolean;
}

/** Checks a create or the result of an edit; returns its next run time. */
export function validateScheduleFields(db: Conn, workflows: WorkflowSource | null, s: ScheduleFields, now: Date): string | null {
  const def = workflows?.get(s.workflowName);
  if (!def) throw badRequest(`workflowName: there is no workflow ${s.workflowName}`);
  if (!def.triggers.includes("schedule")) throw badRequest(`workflowName: ${s.workflowName} cannot run on a schedule`);
  if (s.searchProfileId !== null && !getSearchProfile(db, s.searchProfileId)) {
    throw badRequest(`searchProfileId: search profile ${s.searchProfileId} not found`);
  }
  const input = StartWorkflowInputSchema.safeParse({
    workflow: s.workflowName,
    params: { ...s.params, searchProfileId: s.searchProfileId === null ? null : String(s.searchProfileId) },
  });
  if (!input.success) {
    throw badRequest(`params: ${input.error.issues.map((i) => `${i.path.slice(1).join(".") || "params"}: ${i.message}`).join("; ")}`, input.error.issues);
  }
  let next: string | null;
  try {
    next = computeNextRunAt(s.cron, s.timezone, now);
  } catch (err) {
    throw badRequest(`timezone or cron: ${err instanceof Error ? err.message : String(err)}`);
  }
  return s.enabled ? next : null;
}

function profileId(raw: string | null): number | null {
  if (raw === null) return null;
  if (!/^[1-9]\d{0,15}$/.test(raw)) throw badRequest(`searchProfileId: ${raw} is not a valid id`);
  return Number(raw);
}

/** "Fri 10 Oct · 3 to review" (the prototype's row) from the schedule's last run. */
function lastResult(db: Db, workflows: WorkflowSource | null, s: Schedule): string | null {
  if (s.lastRunId === null) return null;
  const run = getRun(db, s.lastRunId);
  if (!run) return null;
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: s.timezone }).format(new Date(run.createdAt));
  const label = day.replace(/,/g, "");
  const def = workflows?.get(run.workflowName, run.workflowVersion);
  const humanKeys = new Set(def?.steps.filter((x) => x.type === "human").map((x) => x.key) ?? []);
  const toReview = listSteps(db, run.id).filter((x) => x.status === "waiting" && humanKeys.has(x.stepKey)).length;
  const summary = () =>
    (listEvents(db, { runId: run.id, types: ["run.finished"] }).at(-1)?.payload as { summary?: unknown } | undefined)?.summary;
  let text: string;
  switch (run.status) {
    case "running":
      text = toReview > 0 ? `${toReview} to review` : "scanning";
      break;
    case "waiting":
      text = toReview > 0 ? `${toReview} to review` : "waiting";
      break;
    case "paused":
      text = "paused";
      break;
    case "done":
      text = typeof summary() === "string" ? String(summary()) : "done";
      break;
    case "failed":
      text = "failed";
      break;
    case "cancelled":
      text = "cancelled";
      break;
  }
  return `${label} · ${text}`;
}

function view(db: Db, workflows: WorkflowSource | null, s: Schedule): ScheduleView {
  return { ...mappers.toSchedule(s), lastResult: lastResult(db, workflows, s) };
}

export function scheduleRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const workflows = () => ctx.workflows ?? ctx.engine?.deps.workflows ?? null;

  app.get(API_ROUTES.schedules, async () => {
    const db = requireDb(ctx);
    const rows = listSchedules(db).map((s) => view(db, workflows(), s));
    return respond(SchedulesResponseSchema, { schedules: keepValid(ScheduleViewSchema, rows, (m) => ctx.log.warn(m)) });
  });

  app.post(API_ROUTES.schedules, async (req, reply) => {
    const db = requireDb(ctx);
    const body = parseWith(ScheduleCreateRequestSchema, req.body);
    const now = ctx.now();
    const fields: ScheduleFields = {
      cron: body.cron.trim(),
      timezone: body.timezone,
      workflowName: body.workflowName,
      searchProfileId: profileId(body.searchProfileId),
      params: body.params,
      enabled: body.enabled,
    };
    const nextRunAt = validateScheduleFields(db, workflows(), fields, now);
    const row = createSchedule(db, { name: body.name, ...fields, nextRunAt }, { now });
    void reply.code(201);
    return respond(ScheduleViewSchema, view(db, workflows(), row));
  });

  app.get<IdParams>(API_ROUTES.schedule, async (req) => {
    const db = requireDb(ctx);
    const id = idParam(req.params.id, "schedule");
    const row = getSchedule(db, id);
    if (!row) throw notFound(`schedule ${id} not found`);
    return respond(ScheduleViewSchema, view(db, workflows(), row));
  });

  app.patch<IdParams>(API_ROUTES.schedule, async (req) => {
    const db = requireDb(ctx);
    const id = idParam(req.params.id, "schedule");
    const patch = parseWith(ScheduleUpdateRequestSchema, req.body);
    const row = getSchedule(db, id);
    if (!row) throw notFound(`schedule ${id} not found`);
    const now = ctx.now();
    const fields: ScheduleFields = {
      cron: patch.cron?.trim() ?? row.cron,
      timezone: patch.timezone ?? row.timezone,
      workflowName: patch.workflowName ?? row.workflowName,
      searchProfileId: patch.searchProfileId !== undefined ? profileId(patch.searchProfileId) : row.searchProfileId,
      params: (patch.params as JsonObject | undefined) ?? row.params,
      enabled: patch.enabled ?? row.enabled,
    };
    // S23: every edit resets the next run (the scheduler only fills it when it is null).
    const nextRunAt = validateScheduleFields(db, workflows(), fields, now);
    const updated = updateSchedule(db, id, { ...(patch.name !== undefined ? { name: patch.name } : {}), ...fields, nextRunAt }, { now });
    return respond(ScheduleViewSchema, view(db, workflows(), updated));
  });

  app.delete<IdParams>(API_ROUTES.schedule, async (req) => {
    const db = requireDb(ctx);
    const id = idParam(req.params.id, "schedule");
    const now = ctx.now();
    // Stops future scans; past runs, cards and applications stay, and a running scan is not cancelled.
    const row = softDeleteSchedule(db, id, { now });
    const deletedAt = row.deletedAt!;
    return respond(ScheduleDeleteResponseSchema, { deletedAt, undoUntil: new Date(Date.parse(deletedAt) + UNDO_WINDOW_MS).toISOString() });
  });

  app.post<IdParams>(API_ROUTES.scheduleRestore, async (req) => {
    const db = requireDb(ctx);
    const id = idParam(req.params.id, "schedule");
    const now = ctx.now();
    const row = getSchedule(db, id, { includeDeleted: true });
    if (!row) throw notFound(`schedule ${id} not found`);
    if (row.deletedAt === null) throw conflict(`schedule ${id} is not deleted`);
    if (now.getTime() > Date.parse(row.deletedAt) + UNDO_WINDOW_MS) {
      purgeDeletedSchedules(db, { now });
      throw conflict(`the 6 s undo window for schedule ${id} has passed`, { reason: "undo_window_passed" });
    }
    const restored = db.transaction((tx) => {
      const back = restoreSchedule(tx, id, { now });
      return updateSchedule(tx, id, { nextRunAt: back.enabled ? computeNextRunAt(back.cron, back.timezone, now) : null }, { now });
    });
    return respond(ScheduleViewSchema, view(db, workflows(), restored));
  });

  app.post<IdParams>(API_ROUTES.scheduleRunNow, async (req) => {
    const engine = requireEngine(ctx);
    const r = engine.runScheduleNow(idParam(req.params.id, "schedule"));
    return respond(ScheduleRunNowResponseSchema, r.started ? { started: true, runId: String(r.runId) } : r);
  });
}
