// GET /files/:id (§11 file viewer rule): inline for the in-app viewer; `?download=1` is the viewer's
// Download button (Content-Disposition: attachment, the original filename). Only files the id
// resolves to inside data/ are ever read (api/files.ts).
import { createReadStream } from "node:fs";
import { API_ROUTES } from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { requireDb, type ApiContext } from "../context.js";
import { notFound } from "../errors.js";
import { contentDisposition, parseFileId, resolveFile } from "../files.js";

export function fileRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(API_ROUTES.files, async (req, reply) => {
    const db = requireDb(ctx);
    const id = parseFileId(req.params.id);
    const file = id ? await resolveFile(db, ctx.config.dataDir, id) : null;
    if (!file) throw notFound(`file ${req.params.id} not found or not captured`);
    const download = req.query.download === "1";
    void reply
      .header("Content-Type", file.text !== null ? "text/plain; charset=utf-8" : file.ref.mime)
      .header("Content-Length", String(file.size))
      .header("Content-Disposition", contentDisposition(download ? "attachment" : "inline", file.ref.filename))
      .header("Cache-Control", "private, no-store")
      // The viewer embeds files from its own origin (through the proxy); nothing else may.
      .header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'self'; sandbox")
      .header("X-Frame-Options", "SAMEORIGIN");
    return file.text !== null ? file.text : reply.send(createReadStream(file.path!));
  });
}
