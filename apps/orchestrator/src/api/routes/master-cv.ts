// Master CV (UC-20) and saved answers (UC-12). Saving the master CV bumps its version; a save based
// on an older version is refused, so two tabs (or a hand edit) never overwrite each other. Review
// cards built on an older version show "master data changed" (the review queue compares versions).
import {
  API_ROUTES,
  MasterCvSchema,
  MasterCvUpdateRequestSchema,
  MasterCvVersionsResponseSchema,
  FactRequestsResponseSchema,
  OkResponseSchema,
  SavedAnswerSchema,
  SavedAnswersResponseSchema,
} from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { deleteSavedAnswer, listSavedAnswers, mappers } from "../../db/index.js";
import { requireDb, type ApiContext } from "../context.js";
import { conflict, notFound } from "../errors.js";
import { keepValid, parseWith, respond } from "../http.js";
import { keepMasterCvVersion, listMasterCvVersions, readMasterCv, readMasterCvVersion, writeMasterCv } from "../master-cv.js";
import { updateApiState } from "../state.js";
import { openFactRequests } from "../views/fact-requests.js";

export function masterCvRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get(API_ROUTES.masterCv, async () => {
    const read = readMasterCv(ctx.config.dataDir);
    if (read.kind === "missing") throw notFound("there is no master CV yet: add it on the Master CV screen");
    if (read.kind === "invalid") throw conflict(`data/master-cv.yaml cannot be read: ${read.detail}`, { reason: "master_cv_invalid" });
    return respond(MasterCvSchema, read.cv);
  });

  app.put(API_ROUTES.masterCv, async (req) => {
    const body = parseWith(MasterCvUpdateRequestSchema, req.body);
    const current = readMasterCvVersion(ctx.config.dataDir);
    if (current !== null && body.version !== current) {
      throw conflict(`the master CV changed since you opened it (now version ${current}); reload it first`, {
        reason: "master_cv_changed",
        currentVersion: current,
      });
    }
    const saved = { ...body, version: current === null ? 1 : current + 1 };
    await writeMasterCv(ctx.config.dataDir, saved);
    await keepMasterCvVersion(ctx.config.dataDir, saved);
    return respond(MasterCvSchema, saved);
  });

  // UC-20 history: every saved version, newest first (the current file included).
  app.get(API_ROUTES.masterCvVersions, async () => {
    return respond(MasterCvVersionsResponseSchema, { versions: listMasterCvVersions(ctx.config.dataDir) });
  });

  // §6.1: the facts CV asked Ba for and he has not answered.
  app.get(API_ROUTES.masterCvFactRequests, async () => {
    const db = requireDb(ctx);
    return respond(FactRequestsResponseSchema, { requests: openFactRequests(db, ctx.config.dataDir) });
  });

  // "No, I don't": CV goes on without the fact (it never invents one).
  app.post<{ Params: { id: string } }>(API_ROUTES.masterCvFactRequestDismiss, async (req) => {
    const db = requireDb(ctx);
    const id = req.params.id;
    if (!openFactRequests(db, ctx.config.dataDir).some((r) => r.id === id)) throw notFound(`there is no open fact request ${id}`);
    updateApiState(ctx.config.dataDir, (s) => ({ ...s, dismissedFactRequests: [...s.dismissedFactRequests, id] }));
    return respond(OkResponseSchema, { ok: true });
  });

  app.get(API_ROUTES.savedAnswers, async () => {
    const db = requireDb(ctx);
    return respond(SavedAnswersResponseSchema, {
      answers: keepValid(SavedAnswerSchema, listSavedAnswers(db).map(mappers.toSavedAnswer), (m) => ctx.log.warn(m)),
    });
  });

  app.delete<{ Params: { key: string } }>(API_ROUTES.savedAnswer, async (req) => {
    const db = requireDb(ctx);
    if (!deleteSavedAnswer(db, req.params.key)) throw notFound(`there is no saved answer for "${req.params.key}"`);
    return respond(OkResponseSchema, { ok: true });
  });
}
