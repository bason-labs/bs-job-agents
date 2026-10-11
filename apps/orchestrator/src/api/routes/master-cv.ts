// Master CV (UC-20) and saved answers (UC-12). Saving the master CV bumps its version; a save based
// on an older version is refused, so two tabs (or a hand edit) never overwrite each other. Review
// cards built on an older version show "master data changed" (the review queue compares versions).
import {
  API_ROUTES,
  FactDraftRequestSchema,
  FactDraftStartedSchema,
  FactDraftViewSchema,
  FactUndoRequestSchema,
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
import { emitEvent, requireDb, requireEngine, type ApiContext } from "../context.js";
import { conflict, notFound } from "../errors.js";
import { factDraftView, masterBefore, pendingFactDraft, readFactDraft, reopen, saveFactDraft, undoableDraft } from "../fact-drafts.js";
import { keepValid, parseWith, respond } from "../http.js";
import { keepMasterCvVersion, listMasterCvVersions, readMasterCv, readMasterCvVersion, writeMasterCv } from "../master-cv.js";
import { readApiState, updateApiState } from "../state.js";
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
    if (ctx.db) emitEvent(ctx, { type: "master_cv.updated", version: saved.version, change: "saved", factIds: [], taskId: null });
    return respond(MasterCvSchema, saved);
  });

  // Owner request 2026-10-11: Ba's own words (EN or VI) → CV drafts the fact(s); they are added as a
  // new version once CV is done (FactDraftStore, in the settle transaction). 202 + a GET to poll.
  app.post(API_ROUTES.masterCvFactDrafts, async (req, reply) => {
    const body = parseWith(FactDraftRequestSchema, req.body);
    const db = requireDb(ctx);
    const engine = requireEngine(ctx);
    const dataDir = ctx.config.dataDir;
    const read = readMasterCv(dataDir);
    if (read.kind === "missing") throw conflict("create your master CV first, then add facts to it", { reason: "master_cv_missing" });
    if (read.kind === "invalid") throw conflict(`data/master-cv.yaml cannot be read: ${read.detail}`, { reason: "master_cv_invalid" });
    if (body.version !== read.cv.version) {
      throw conflict(`the master CV changed since you opened it (now version ${read.cv.version}); reload it first`, {
        reason: "master_cv_changed",
        currentVersion: read.cv.version,
      });
    }
    const requestId = body.factRequestId ?? null;
    const request = requestId === null ? null : (openFactRequests(db, dataDir).find((r) => r.id === requestId) ?? null);
    if (requestId !== null && !request) throw notFound(`there is no open fact request ${requestId}`);
    const pending = Object.values(readApiState(dataDir).factDrafts).find((d) => d.status === "pending" && requestId !== null && d.factRequestId === requestId);
    if (pending && ["queued", "running"].includes(factDraftView(db, dataDir, pending.taskId)?.status ?? "")) {
      throw conflict("CV is already drafting an answer to this question", { reason: "draft_pending", taskId: String(pending.taskId) });
    }
    const { taskId } = engine.enqueueFactDraft({
      text: body.text,
      question: request ? { topic: request.topic, question: request.question, reason: request.reason, company: request.company } : null,
      existingFacts: read.cv.facts.map((f) => ({ id: f.id, type: f.type, org: f.org, dates: f.dates })),
      masterCvVersion: read.cv.version,
    });
    // Recorded before CV can finish (its runner starts after an await); a task the trust guard
    // refused at once was already recorded as failed by the sink, so that record is completed.
    const meta = { factRequestId: requestId, jobId: request?.jobId ?? null, company: request?.company ?? null };
    const early = readFactDraft(dataDir, taskId);
    saveFactDraft(
      dataDir,
      early ? { ...early, ...meta } : pendingFactDraft({ taskId, text: body.text, ...meta, baseVersion: read.cv.version, createdAt: ctx.now().toISOString() }),
    );
    void reply.code(202);
    return respond(FactDraftStartedSchema, { taskId: String(taskId) });
  });

  app.get<{ Params: { taskId: string } }>(API_ROUTES.masterCvFactDraft, async (req) => {
    const db = requireDb(ctx);
    const taskId = Number(req.params.taskId);
    const view = Number.isInteger(taskId) && taskId > 0 ? factDraftView(db, ctx.config.dataDir, taskId) : null;
    if (!view) throw notFound(`there is no fact draft ${req.params.taskId}`);
    return respond(FactDraftViewSchema, view);
  });

  // Undo: the facts drafted from Ba's words go again. Only while that addition is the latest change;
  // the version before is restored as a new version (versions only go up, so review cards notice).
  app.post(API_ROUTES.masterCvFactsUndo, async (req) => {
    const body = parseWith(FactUndoRequestSchema, req.body);
    const dataDir = ctx.config.dataDir;
    const read = readMasterCv(dataDir);
    if (read.kind !== "ok") throw conflict("the master CV cannot be read, so nothing can be undone", { reason: read.kind === "missing" ? "master_cv_missing" : "master_cv_invalid" });
    const current = read.cv;
    if (current.version !== body.version) {
      throw conflict(`only the latest change can be undone: the master CV is now version ${current.version}`, {
        reason: "master_cv_changed",
        currentVersion: current.version,
      });
    }
    const draft = undoableDraft(dataDir, body.version);
    if (!draft) throw conflict(`version ${body.version} did not add facts from your words, or it was already undone`, { reason: "not_undoable" });
    const restored = { ...masterBefore(dataDir, draft, current), version: current.version + 1 };
    await writeMasterCv(dataDir, restored);
    await keepMasterCvVersion(dataDir, restored);
    updateApiState(dataDir, (s) => {
      const rec = s.factDrafts[String(draft.taskId)];
      const next = rec ? { ...s, factDrafts: { ...s.factDrafts, [String(draft.taskId)]: { ...rec, undoneAt: ctx.now().toISOString() } } } : s;
      return reopen(next, draft.factRequestId);
    });
    if (ctx.db) emitEvent(ctx, { type: "master_cv.updated", version: restored.version, change: "undo", factIds: draft.facts.map((f) => f.id), taskId: String(draft.taskId) });
    return respond(MasterCvSchema, restored);
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
