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
} from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { getApplication, getLastExport, listApplications, mappers, transitionApplication } from "../../db/index.js";
import { emitEvent, requireDb, type ApiContext } from "../context.js";
import { notFound } from "../errors.js";
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
}
