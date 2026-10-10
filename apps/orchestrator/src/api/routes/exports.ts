// ⬇ Export all (UC-13b): POST builds the ZIP and answers with its download URL (the viewer's
// Download, GET /files/export-<id>?download=1); GET lists past exports, newest first.
import { API_ROUTES, ExportRequestSchema, ExportResponseSchema, ExportSchema, ExportsResponseSchema, fileUrl } from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { listExports, mappers } from "../../db/index.js";
import { emitEvent, requireDb, type ApiContext } from "../context.js";
import { exportApplications } from "../export.js";
import { formatFileId } from "../files.js";
import { keepValid, parseWith, respond } from "../http.js";

export function exportRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.post(API_ROUTES.exports, async (req, reply) => {
    const db = requireDb(ctx);
    parseWith(ExportRequestSchema, req.body ?? {});
    const row = await exportApplications(db, ctx.config.dataDir, ctx.now(), (m) => ctx.log.warn(m));
    const exp = mappers.toExport(row);
    emitEvent(ctx, { type: "export.ready", export: exp });
    void reply.code(201);
    return respond(ExportResponseSchema, { export: exp, downloadUrl: fileUrl(formatFileId({ type: "export", id: row.id }), { download: true }) });
  });

  app.get(API_ROUTES.exports, async () => {
    const db = requireDb(ctx);
    return respond(ExportsResponseSchema, { exports: keepValid(ExportSchema, listExports(db).map(mappers.toExport), (m) => ctx.log.warn(m)) });
  });
}
