// The mock orchestrator's REST routes for WebApi.request: every API_ROUTES entry the screens call
// by template (the W3c settings screens' adapters, plus the chat and shell routes on WebApi). Each
// handler answers like the orchestrator's route of the same name (apps/orchestrator/src/api/routes):
// the same request schemas (400 validation_failed), status rules (403 forbidden, 404 not_found,
// 409 conflict with `details.reason`), and a response checked against the shared response schema.
import {
  API_ROUTES,
  ApplicationDetailSchema,
  ApplicationStatusChangeRequestSchema,
  ApplicationStatusChangeResponseSchema,
  ApplicationsResponseSchema,
  ApplyAgainResponseSchema,
  BotDefinitionSchema,
  BotUpdateRequestSchema,
  BotViewSchema,
  BotsResponseSchema,
  BridgesResponseSchema,
  ChatSendRequestSchema,
  ChatSendResultSchema,
  ChoiceRequestSchema,
  CreateRoomRequestSchema,
  CriteriaResponseSchema,
  CriteriaUpdateRequestSchema,
  CriteriaVersionsResponseSchema,
  EnginesResponseSchema,
  ExportResponseSchema,
  ExportsResponseSchema,
  FactRequestsResponseSchema,
  HealthStatusSchema,
  LIMITS,
  MasterCvSchema,
  MasterCvUpdateRequestSchema,
  MasterCvVersionsResponseSchema,
  MessagesResponseSchema,
  OkResponseSchema,
  RoomSchema,
  RoomsResponseSchema,
  SavedAnswersResponseSchema,
  ScheduleCreateRequestSchema,
  ScheduleDeleteResponseSchema,
  ScheduleRunNowResponseSchema,
  ScheduleUpdateRequestSchema,
  ScheduleViewSchema,
  SchedulesResponseSchema,
  SearchProfilesResponseSchema,
  WorkflowProposalApproveResponseSchema,
  WorkflowProposalSchema,
  WorkflowProposalsResponseSchema,
  canChangeApplicationStatus,
  checkBotSafety,
  maxTrustLevel,
  modelSuitsEngine,
  type Application,
  type ApplicationListItem,
  type ApprovalSummary,
  type BotView,
  type ScheduleView,
  type SearchProfile,
} from "@bs-job-agents/shared";
import { botDefinitionFixtures } from "@bs-job-agents/shared/fixtures";
import type { z } from "zod";
import type { ApiRequestOptions, HttpMethod } from "../contract";
import { ApiRequestError } from "../errors";
import type { QueryValue } from "../routes";
import type { MockBackend } from "./backend";
import { activeProfile, saveCriteria } from "./criteria";
import { residualRiskFor } from "./seed-bots";
import * as sim from "./sim";
import type { ApplicationExtra } from "./state";

export interface MockRequest {
  params: Record<string, string>;
  query: Record<string, QueryValue>;
  body: unknown;
  form?: FormData;
}

export interface MockRoute {
  method: HttpMethod;
  /** The API_ROUTES template (`/applications/:id`). */
  route: string;
  /** The shared response schema the orchestrator checks its answer with; null = no body. */
  response: z.ZodTypeAny | null;
  handle(core: MockBackend, req: MockRequest): unknown;
}

const fail = (status: number, code: ApiRequestError["code"], message: string, details: unknown = null) =>
  new ApiRequestError({ status, code, message, details });
const notFound = (message: string) => fail(404, "not_found", message);
const conflict = (message: string, details: unknown = null) => fail(409, "conflict", message, details);
const forbidden = (message: string) => fail(403, "forbidden", message);

/** The orchestrator's parseWith: 400 validation_failed with "path: message" and the issues. */
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data as z.output<S>;
  const message = r.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
  throw fail(400, "validation_failed", message, r.error.issues);
}

/** A data: URL of a valid, empty ZIP (the mock's export download). */
export const EMPTY_ZIP = "data:application/zip;base64,UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==";

// ---------------------------------------------------------------- applications

/** Job, CV and files for an application; the sim's approvals get theirs from the review card. */
function extraFor(core: MockBackend, id: string): ApplicationExtra | null {
  const known = core.state.applicationExtras[id];
  if (known) return known;
  const app = core.state.applications[id];
  if (!app) return null;
  const card = [...core.state.queue, ...core.acted].find((c) => c.job.id === app.jobId);
  if (!card) return null;
  const option = card.cvOptions.find((o) => o.cvVersion.id === app.cvVersionId) ?? card.cvOptions[0];
  const cv = option?.cvVersion;
  return {
    job: { id: card.job.id, title: card.job.title, company: card.job.company, url: card.job.url, source: card.job.source },
    cvVersion: cv
      ? { id: cv.id, label: cv.figmaFrameName, language: cv.language, pdfFileId: option.pdf?.id ?? null, figmaFrameUrl: cv.figmaFrameUrl }
      : null,
    submission: null,
    files: option?.pdf ? [option.pdf] : [],
    confirmationScreenshotFileId: null,
    preSubmitScreenshotFileId: null,
    partialRecord: app.status !== "approved" && app.status !== "paused",
    cvFile: option?.pdf ?? null,
  };
}

/**
 * PM3 S3, as views/applications.ts: Ba's approval (time, CV version, the job's site), also before a
 * record exists. None for an imported application.
 */
function approvalOf(app: Application, x: ApplicationExtra): ApprovalSummary | null {
  if (x.submission?.approval) return x.submission.approval;
  if (app.origin === "imported") return null;
  const approvedAt = app.statusHistory.find((h) => h.status === "approved")?.at;
  if (!approvedAt) return null;
  let host: string | null = null;
  try {
    host = x.job.url ? new URL(x.job.url).hostname.replace(/^(www\.|m\.)/, "") : null;
  } catch {
    host = null;
  }
  return { approvedAt, cvVersionId: app.cvVersionId, allowedDomains: host ? [host] : [], note: app.dryRun ? "dry run" : null };
}

function applicationRows(core: MockBackend): ApplicationListItem[] {
  const rows: ApplicationListItem[] = [];
  for (const app of Object.values(core.state.applications)) {
    const x = extraFor(core, app.id);
    if (!x) continue;
    rows.push({
      application: app,
      job: x.job,
      cvVersion: x.cvVersion,
      confirmationScreenshotFileId: x.confirmationScreenshotFileId,
      preSubmitScreenshotFileId: x.preSubmitScreenshotFileId,
      partialRecord: x.partialRecord,
      cvFile: x.cvFile,
    });
  }
  return rows;
}

function application(core: MockBackend, id: string) {
  const app = core.state.applications[id];
  if (!app) throw notFound(`application ${id} not found`);
  return app;
}

// ---------------------------------------------------------------- schedules

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const VN_OFFSET_MS = 7 * 3600_000; // Asia/Ho_Chi_Minh, no DST

function cronDays(field: string): Set<number> | null {
  if (field === "*") return new Set([0, 1, 2, 3, 4, 5, 6]);
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) for (let d = Number(range[1]); d <= Number(range[2]); d++) days.add(d % 7);
    else if (/^\d$/.test(part)) days.add(Number(part) % 7);
    else if (DAY_NAMES.includes(part)) days.add(DAY_NAMES.indexOf(part));
    else return null;
  }
  return days;
}

/** Next fire time of "m h * * dow" in Vietnam time; null for anything fancier (the orchestrator uses croner). */
export function mockNextRunAt(cron: string, now: Date): string | null {
  const [m, h, dom, mon, dow] = cron.trim().split(/\s+/);
  if (!m || !h || dom !== "*" || mon !== "*" || !dow || !/^\d+$/.test(m) || !/^\d+$/.test(h)) return null;
  const days = cronDays(dow);
  if (!days) return null;
  const local = new Date(now.getTime() + VN_OFFSET_MS);
  for (let i = 0; i <= 7; i++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i, Number(h), Number(m)));
    const at = day.getTime() - VN_OFFSET_MS;
    if (at > now.getTime() && days.has(day.getUTCDay())) return new Date(at).toISOString();
  }
  return null;
}

function checkSchedule(core: MockBackend, s: Pick<ScheduleView, "workflowName" | "searchProfileId">): void {
  if (s.workflowName !== "job-scan") throw fail(400, "validation_failed", `workflowName: ${s.workflowName} cannot run on a schedule`);
  if (s.searchProfileId !== null && !core.state.profiles.some((p) => p.id === s.searchProfileId)) {
    throw fail(400, "validation_failed", `searchProfileId: search profile ${s.searchProfileId} not found`);
  }
}

function schedule(core: MockBackend, id: string, o: { includeDeleted?: boolean } = {}): ScheduleView {
  const row = core.state.schedules.find((s) => s.id === id && (o.includeDeleted || s.deletedAt === null));
  if (!row) throw notFound(`schedule ${id} not found`);
  return row;
}

/** Soft-deleted schedules past their undo window are gone for good (purgeDeletedSchedules). */
function purgeSchedules(core: MockBackend): void {
  const now = core.nowMs();
  core.state.schedules = core.state.schedules.filter((s) => s.deletedAt === null || now <= Date.parse(s.deletedAt) + LIMITS.scheduleUndoMs);
}

const nextRun = (core: MockBackend, s: Pick<ScheduleView, "cron" | "enabled">) => (s.enabled ? mockNextRunAt(s.cron, new Date(core.nowMs())) : null);

// ---------------------------------------------------------------- bots

/** The API's trust rule (W3a routes/bots.ts trustRefusal). */
function trustRefusal(name: string, from: number, to: number): string | null {
  if (to <= from) return null;
  const cap = maxTrustLevel(name);
  if (to > cap) return name === "apply" ? "Apply stays at L1 in Phase 1: every submit needs Ba's approval (UC-19)" : `${name} may be at most L${cap} in Phase 1`;
  if (to > from + 1) return `raise ${name}'s trust level one step at a time (L${from} → L${from + 1})`;
  return null;
}

function bot(core: MockBackend, name: string): BotView {
  const b = core.state.bots.find((x) => x.name === name);
  if (!b) throw notFound(`bot ${name} not found`);
  return b;
}

function botUpdated(core: MockBackend, b: BotView): BotView {
  core.emit({ type: "bot.updated", botName: b.name, engine: b.engine, trustLevel: b.trustLevel, enabled: b.enabled, activity: b.activity, promotionSuggested: b.promotionSuggested });
  return b;
}

// ---------------------------------------------------------------- the table

const route = (method: HttpMethod, path: string, response: z.ZodTypeAny | null, handle: MockRoute["handle"]): MockRoute => ({ method, route: path, response, handle });

export const MOCK_ROUTES: readonly MockRoute[] = [
  // ------------------------------------------------ shell
  route("GET", API_ROUTES.health, HealthStatusSchema, () => ({ ok: true })),
  route("GET", API_ROUTES.bridges, BridgesResponseSchema, (core) => ({
    chrome: (["claude", "codex"] as const).map((engine) => ({ engine, connected: core.state.chromeConnected })),
    checkedAt: core.nowIso(),
  })),
  route("GET", API_ROUTES.engines, EnginesResponseSchema, async (core) => ({ engines: await core.listEngines() })),

  // ------------------------------------------------ rooms and chat (UC-15, UC-25)
  route("GET", API_ROUTES.rooms, RoomsResponseSchema, async (core) => ({ rooms: await core.listRooms() })),
  route("POST", API_ROUTES.rooms, RoomSchema, (core, req) => {
    const body = parse(CreateRoomRequestSchema, req.body);
    const unknown = body.members.filter((m) => !core.state.bots.some((b) => b.name === m));
    if (unknown.length > 0) throw fail(400, "validation_failed", `members: no bot named ${unknown.join(", ")}`);
    const room = { id: core.nextId(), name: body.name, kind: "group" as const, botName: null, members: [...new Set(body.members)], createdAt: core.nowIso() };
    core.state.rooms.push(room);
    core.state.messages[room.id] = [];
    return room;
  }),
  route("GET", API_ROUTES.roomMessages, MessagesResponseSchema, (core, req) => {
    const limit = req.query.limit === undefined || req.query.limit === null ? undefined : Number(req.query.limit);
    const before = typeof req.query.before === "string" ? req.query.before : undefined;
    return core.listMessages(req.params.id!, { before, limit });
  }),
  route("POST", API_ROUTES.chatSend, ChatSendResultSchema, async (core, req) => {
    const body = parse(ChatSendRequestSchema, req.body);
    const room = core.room(body.roomId);
    const message = await core.sendMessage({ roomId: room.id, text: body.text, uploadIds: body.uploadIds });
    return { message, taskIds: [] };
  }),
  route("POST", API_ROUTES.chatChoices, ChatSendResultSchema, async (core, req) => ({ message: await core.choose(parse(ChoiceRequestSchema, req.body)), taskIds: [] })),

  // ------------------------------------------------ applications (UC-13, UC-13b)
  route("GET", API_ROUTES.applications, ApplicationsResponseSchema, (core) => ({
    applications: applicationRows(core),
    lastExportAt: core.state.exports.at(-1)?.createdAt ?? null,
    dataDir: core.state.dataDir,
  })),
  route("GET", API_ROUTES.application, ApplicationDetailSchema, (core, req) => {
    const app = application(core, req.params.id!);
    const x = extraFor(core, app.id);
    if (!x) throw notFound(`application ${app.id} not found`);
    return { application: app, job: x.job, cvVersion: x.cvVersion, submission: x.submission, files: x.files, approval: approvalOf(app, x) };
  }),
  route("POST", API_ROUTES.applicationStatus, ApplicationStatusChangeResponseSchema, (core, req) => {
    const app = application(core, req.params.id!);
    const body = parse(ApplicationStatusChangeRequestSchema, req.body);
    if (!canChangeApplicationStatus(app.status, body.status, { dryRun: app.dryRun })) {
      throw conflict(`an application that is ${app.status.replace(/_/g, " ")} can't be changed to ${body.status.replace(/_/g, " ")}`);
    }
    app.status = body.status;
    app.statusHistory = [...app.statusHistory, { status: body.status, at: core.nowIso(), note: body.note }];
    if (body.status === "submitted" && !app.submittedAt) app.submittedAt = core.nowIso();
    core.emit({ type: "application.updated", applicationId: app.id, jobId: app.jobId, status: app.status, origin: app.origin });
    return { application: app };
  }),
  route("POST", API_ROUTES.applicationApplyAgain, ApplyAgainResponseSchema, (core, req) => {
    const app = application(core, req.params.id!);
    if (app.status !== "failed") throw conflict(`only a failed application can be applied to again (this one is ${app.status.replace(/_/g, " ")})`);
    const url = extraFor(core, app.id)?.job.url;
    if (!url) throw conflict("this job has no apply link, so it cannot be applied to again from here");
    return { jobId: app.jobId, runId: sim.startApplyAgain(core, url) };
  }),
  route("GET", API_ROUTES.exports, ExportsResponseSchema, (core) => ({ exports: [...core.state.exports].reverse() })),
  route("POST", API_ROUTES.exports, ExportResponseSchema, (core) => {
    const createdAt = core.nowIso();
    const exp = {
      id: core.nextId(),
      createdAt,
      path: `data/exports/job-agents-export_${createdAt.slice(0, 10)}.zip`,
      applicationCount: Object.values(core.state.applications).filter((a) => !a.dryRun).length,
    };
    core.state.exports.push(exp);
    return { export: exp, downloadUrl: EMPTY_ZIP };
  }),

  // ------------------------------------------------ search criteria and saved answers (UC-21b, UC-12)
  route("GET", API_ROUTES.criteria, CriteriaResponseSchema, (core) => {
    const active = activeProfile(core);
    if (!active) throw notFound("there are no search criteria yet");
    return active;
  }),
  route("PUT", API_ROUTES.criteria, CriteriaResponseSchema, (core, req) => saveCriteria(core, parse(CriteriaUpdateRequestSchema, req.body))),
  route("GET", API_ROUTES.criteriaVersions, CriteriaVersionsResponseSchema, (core) => {
    const active = activeProfile(core);
    const rows = active ? core.state.profiles.filter((p) => p.name === active.name) : [];
    return { versions: rows.map((p) => ({ version: p.version, updatedAt: p.updatedAt, active: p.active })).sort((a, b) => b.version - a.version) };
  }),
  route("GET", API_ROUTES.criteriaProfiles, SearchProfilesResponseSchema, (core) => {
    const newest = new Map<string, SearchProfile>();
    for (const p of core.state.profiles) if (!newest.has(p.name) || p.version > newest.get(p.name)!.version) newest.set(p.name, p);
    return { profiles: [...newest.values()] };
  }),
  route("GET", API_ROUTES.savedAnswers, SavedAnswersResponseSchema, (core) => ({
    answers: [...core.state.savedAnswers].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
  })),
  route("DELETE", API_ROUTES.savedAnswer, OkResponseSchema, (core, req) => {
    const key = req.params.key!;
    if (!core.state.savedAnswers.some((a) => a.key === key)) throw notFound(`there is no saved answer for "${key}"`);
    core.state.savedAnswers = core.state.savedAnswers.filter((a) => a.key !== key);
    return { ok: true };
  }),

  // ------------------------------------------------ schedules (UC-21)
  route("GET", API_ROUTES.schedules, SchedulesResponseSchema, (core) => {
    purgeSchedules(core);
    return { schedules: core.state.schedules.filter((s) => s.deletedAt === null) };
  }),
  route("POST", API_ROUTES.schedules, ScheduleViewSchema, (core, req) => {
    const body = parse(ScheduleCreateRequestSchema, req.body);
    checkSchedule(core, body);
    const row: ScheduleView = { id: core.nextId(), ...body, cron: body.cron.trim(), lastRunId: null, nextRunAt: nextRun(core, body), deletedAt: null, lastResult: null };
    core.state.schedules.push(row);
    return row;
  }),
  route("GET", API_ROUTES.schedule, ScheduleViewSchema, (core, req) => schedule(core, req.params.id!)),
  route("PATCH", API_ROUTES.schedule, ScheduleViewSchema, (core, req) => {
    const patch = parse(ScheduleUpdateRequestSchema, req.body);
    const row = schedule(core, req.params.id!);
    const next = { ...row, ...patch, cron: (patch.cron ?? row.cron).trim() };
    checkSchedule(core, next);
    Object.assign(row, next, { nextRunAt: nextRun(core, next) });
    return row;
  }),
  route("DELETE", API_ROUTES.schedule, ScheduleDeleteResponseSchema, (core, req) => {
    const row = schedule(core, req.params.id!);
    row.deletedAt = core.nowIso();
    row.nextRunAt = null;
    return { deletedAt: row.deletedAt, undoUntil: new Date(Date.parse(row.deletedAt) + LIMITS.scheduleUndoMs).toISOString() };
  }),
  route("POST", API_ROUTES.scheduleRestore, ScheduleViewSchema, (core, req) => {
    const id = req.params.id!;
    const row = schedule(core, id, { includeDeleted: true });
    if (row.deletedAt === null) throw conflict(`schedule ${id} is not deleted`);
    if (core.nowMs() > Date.parse(row.deletedAt) + LIMITS.scheduleUndoMs) {
      purgeSchedules(core);
      throw conflict(`the 6 s undo window for schedule ${id} has passed`, { reason: "undo_window_passed" });
    }
    row.deletedAt = null;
    row.nextRunAt = nextRun(core, row);
    return row;
  }),
  route("POST", API_ROUTES.scheduleRunNow, ScheduleRunNowResponseSchema, (core, req) => {
    const row = schedule(core, req.params.id!);
    if (sim.scheduleIsRunning(core, row.id)) return { started: false, reason: "overlap" };
    const runId = sim.startScheduledScan(core, row);
    row.lastRunId = runId;
    row.lastResult = `${new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: row.timezone }).format(new Date(core.nowMs())).replace(/,/g, "")} · scanning`;
    return { started: true, runId };
  }),

  // ------------------------------------------------ bots (§11 Bots, UC-19, PM S14/S21)
  route("GET", API_ROUTES.bots, BotsResponseSchema, async (core) => ({ bots: await core.listBots() })),
  route("GET", API_ROUTES.bot, BotViewSchema, (core, req) => bot(core, req.params.name!)),
  route("PATCH", API_ROUTES.bot, BotViewSchema, (core, req) => {
    const b = bot(core, req.params.name!);
    const patch = parse(BotUpdateRequestSchema, req.body);
    if (patch.engine !== undefined && patch.engine !== b.engine) {
      const def = botDefinitionFixtures.find((d) => d.name === b.name);
      const issues = def ? checkBotSafety({ ...BotDefinitionSchema.parse(def), engine: patch.engine }) : [];
      if (issues.length > 0) throw forbidden(issues.join("; "));
    }
    if (patch.trustLevel !== undefined) {
      const refusal = trustRefusal(b.name, b.trustLevel, patch.trustLevel);
      if (refusal) throw forbidden(refusal);
      if (patch.trustLevel > b.trustLevel) {
        b.promotionSuggested = false;
        if (b.demotion && patch.trustLevel >= b.demotion.fromLevel) b.demotion = null;
      }
      b.trustLevel = patch.trustLevel;
      b.promoteAllowed = b.trustLevel < maxTrustLevel(b.name);
    }
    // Live run 1: like the orchestrator, the model must suit the engine after this change; an
    // engine switch drops a model that no longer suits it; null goes back to bot.json's model.
    const engine = patch.engine ?? b.engine;
    if (patch.model !== undefined && patch.model !== null && !modelSuitsEngine(patch.model, engine)) {
      throw fail(400, "validation_failed", `${patch.model} is not a model for ${engine === "claude" ? "Claude" : "Codex"}, which ${b.name} runs on`);
    }
    if (patch.engine !== undefined) {
      b.engine = patch.engine;
      b.residualRisk = residualRiskFor(b.name, b.engine);
    }
    if (patch.model !== undefined) b.model = patch.model ?? b.defaultModel ?? null;
    else if (patch.engine !== undefined && b.model !== null && b.model !== (b.defaultModel ?? null) && !modelSuitsEngine(b.model, b.engine)) b.model = b.defaultModel ?? null;
    if (patch.enabled !== undefined) b.enabled = patch.enabled;
    return botUpdated(core, b);
  }),
  route("DELETE", API_ROUTES.botMemoryNote, BotViewSchema, (core, req) => {
    const b = bot(core, req.params.name!);
    const note = b.memoryNotes?.find((n) => n.id === req.params.noteId);
    if (!note) throw notFound(`bot ${b.name} has no memory note ${req.params.noteId}`);
    b.memoryNotes = b.memoryNotes!.filter((n) => n.id !== note.id);
    b.memory = b.memory.filter((m) => m !== note.text);
    return botUpdated(core, b);
  }),
  route("POST", API_ROUTES.botPromotionDismiss, BotViewSchema, (core, req) => {
    const b = bot(core, req.params.name!);
    if (!b.promotionSuggested) throw conflict(`there is no promotion suggestion for ${b.name}`);
    b.promotionSuggested = false;
    return botUpdated(core, b);
  }),

  // ------------------------------------------------ master CV (UC-20, §6.1)
  route("GET", API_ROUTES.masterCv, MasterCvSchema, (core) => {
    const m = core.state.masterCv;
    if (m.kind === "missing") throw notFound("there is no master CV yet: add it on the Master CV screen");
    if (m.kind === "invalid") throw conflict(`data/master-cv.yaml cannot be read: ${m.detail}`, { reason: "master_cv_invalid" });
    return m.cv;
  }),
  route("PUT", API_ROUTES.masterCv, MasterCvSchema, (core, req) => {
    const body = parse(MasterCvUpdateRequestSchema, req.body);
    const m = core.state.masterCv;
    const current = m.kind === "ok" ? m.cv.version : null;
    if (current !== null && body.version !== current) {
      throw conflict(`the master CV changed since you opened it (now version ${current}); reload it first`, { reason: "master_cv_changed", currentVersion: current });
    }
    const saved = { ...body, version: current === null ? 1 : current + 1 };
    core.state.masterCv = { kind: "ok", cv: saved };
    core.state.masterCvVersions.push({ version: saved.version, savedAt: core.nowIso(), factCount: saved.facts.length });
    return saved;
  }),
  route("GET", API_ROUTES.masterCvVersions, MasterCvVersionsResponseSchema, (core) => ({
    versions: [...core.state.masterCvVersions].sort((a, b) => b.version - a.version),
  })),
  route("GET", API_ROUTES.masterCvFactRequests, FactRequestsResponseSchema, (core) => ({ requests: core.state.factRequests })),
  route("POST", API_ROUTES.masterCvFactRequestDismiss, OkResponseSchema, (core, req) => {
    const id = req.params.id!;
    if (!core.state.factRequests.some((r) => r.id === id)) throw notFound(`there is no open fact request ${id}`);
    core.state.factRequests = core.state.factRequests.filter((r) => r.id !== id);
    return { ok: true };
  }),

  // ------------------------------------------------ workflow proposals (rule 3, PM S22)
  route("GET", API_ROUTES.workflowProposals, WorkflowProposalsResponseSchema, (core) => ({ proposals: [...core.state.proposals].reverse() })),
  route("POST", API_ROUTES.workflowProposalApprove, WorkflowProposalApproveResponseSchema, (core, req) => {
    const p = pendingProposal(core, req.params.id!);
    const version = (core.state.savedWorkflows[p.name] ?? 0) + 1;
    core.state.savedWorkflows[p.name] = version;
    Object.assign(p, { status: "approved", decidedAt: core.nowIso(), savedVersion: version });
    return { proposal: p, workflow: { name: p.name, version } };
  }),
  route("POST", API_ROUTES.workflowProposalDismiss, WorkflowProposalSchema, (core, req) => {
    const p = pendingProposal(core, req.params.id!);
    Object.assign(p, { status: "dismissed", decidedAt: core.nowIso() });
    return p;
  }),
];

function pendingProposal(core: MockBackend, id: string) {
  const p = core.state.proposals.find((x) => x.id === id);
  if (!p) throw notFound(`workflow proposal ${id} not found`);
  if (p.status !== "pending") throw conflict(`workflow proposal ${id} was already ${p.status}`);
  return p;
}

/** Answers one request like the orchestrator; the response is checked against its shared schema. */
export async function handleMockRequest(core: MockBackend, method: HttpMethod, path: string, opts: ApiRequestOptions = {}): Promise<unknown> {
  const r = MOCK_ROUTES.find((x) => x.method === method && x.route === path);
  if (!r) throw notFound(`no route ${method} ${path}`);
  const out = await r.handle(core, { params: opts.params ?? {}, query: opts.query ?? {}, body: opts.body, form: opts.form });
  if (!r.response) return undefined;
  const checked = r.response.safeParse(out);
  if (!checked.success) throw fail(500, "internal", `response does not match its schema: ${checked.error.issues[0]?.message ?? "invalid"}`);
  return structuredClone(checked.data);
}
