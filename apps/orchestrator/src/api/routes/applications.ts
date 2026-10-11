// Applications (UC-13): the table, the submission record panel and Ba's manual status changes
// (the shared status machine's `manual` row: needs_check → submitted | failed, then freely between
// post-submit statuses; a dry run never becomes submitted).
import {
  API_ROUTES,
  ApplicationDetailSchema,
  ApplicationListItemSchema,
  ApplicationStatusChangeRequestSchema,
  ApplicationStatusChangeResponseSchema,
  ApplicationsResponseSchema,
  ApplyAgainResponseSchema,
} from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { getApplication, getJob, getLastExport, listApplications, mappers, transitionApplication } from "../../db/index.js";
import { emitEvent, requireDb, requireEngine, type ApiContext } from "../context.js";
import { conflict, notFound } from "../errors.js";
import { idParam, keepValid, parseWith, respond } from "../http.js";
import { applicationDetail, applicationListItem } from "../views/applications.js";

type IdParams = { Params: { id: string } };

export function applicationRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const warn = (m: string) => ctx.log.warn(m);

  app.get(API_ROUTES.applications, async () => {
    const db = requireDb(ctx);
    const items: unknown[] = [];
    for (const row of listApplications(db)) items.push(await applicationListItem(db, ctx.config.dataDir, row));
    return respond(ApplicationsResponseSchema, {
      applications: keepValid(ApplicationListItemSchema, items.filter((i) => i !== null), warn),
      lastExportAt: getLastExport(db)?.createdAt ?? null,
      dataDir: ctx.config.dataDir,
    });
  });

  app.get<IdParams>(API_ROUTES.application, async (req) => {
    const db = requireDb(ctx);
    const id = idParam(req.params.id, "application");
    const row = getApplication(db, id);
    const detail = row ? await applicationDetail(db, ctx.config.dataDir, row, warn) : null;
    if (!detail) throw notFound(`application ${id} not found`);
    return respond(ApplicationDetailSchema, detail);
  });

  app.post<IdParams>(API_ROUTES.applicationStatus, async (req) => {
    const db = requireDb(ctx);
    const id = idParam(req.params.id, "application");
    const body = parseWith(ApplicationStatusChangeRequestSchema, req.body);
    const moved = transitionApplication(db, id, body.status, { by: "manual", now: ctx.now(), ...(body.note !== null ? { note: body.note } : {}) });
    emitEvent(ctx, { type: "application.updated", applicationId: String(moved.id), jobId: String(moved.jobId), status: moved.status, origin: moved.origin });
    return respond(ApplicationStatusChangeResponseSchema, { application: mappers.toApplication(moved) });
  });

  // "Apply again" for a failed application (§10.2 rule 5, UC-14 a): a new apply-to-link run with
  // applyAgain, through the engine. Its review card comes back; nothing is sent without Ba's approval.
  app.post<IdParams>(API_ROUTES.applicationApplyAgain, async (req, reply) => {
    const engine = requireEngine(ctx);
    const id = idParam(req.params.id, "application");
    const row = getApplication(engine.db, id);
    if (!row) throw notFound(`application ${id} not found`);
    if (row.status !== "failed") throw conflict(`only a failed application can be applied to again (this one is ${row.status.replace(/_/g, " ")})`);
    const job = getJob(engine.db, row.jobId);
    if (!job?.url) throw conflict("this job has no apply link, so it cannot be applied to again from here");
    const run = engine.startWorkflow({ workflow: "apply-to-link", params: { url: job.url, applyAgain: true, searchProfileId: null } }, { trigger: "link" });
    void reply.code(201);
    return respond(ApplyAgainResponseSchema, { jobId: String(job.id), runId: String(run.id) });
  });
}
