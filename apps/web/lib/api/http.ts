// The orchestrator over HTTP (§4.2): a typed client over API_ROUTES, validated with the shared
// response schemas. Browser calls go through the same-origin /api rewrite (next.config.ts: the
// orchestrator sends no CORS headers); server components call the orchestrator directly (config.ts).
import {
  API_ROUTES,
  AnswerQuestionResponseSchema,
  ApproveResponseSchema,
  BotsResponseSchema,
  BridgesResponseSchema,
  ChatSendResultSchema,
  EnginesResponseSchema,
  HealthStatusSchema,
  MessagesResponseSchema,
  ReviewQueueResponseSchema,
  RoomsResponseSchema,
  RunControlResponseSchema,
  RunDetailSchema,
  RunsResponseSchema,
  StepDetailSchema,
  TranscriptResponseSchema,
  UploadsResponseSchema,
  fileUrl,
} from "@bs-job-agents/shared";
import type { z } from "zod";
import type { ApiRequestOptions, EventFeed, HealthState, RunRow, WebApi } from "./contract";
import { csrfHeaders } from "./csrf";
import { ApiRequestError, apiErrorFromResponse } from "./errors";
import { toBotSummary, toRoomSummary, toShellData } from "./map";
import { apiPath } from "./routes";

export interface HttpClientOptions {
  /** `http://127.0.0.1:4100` on the server, `/api` in the browser. */
  baseUrl: string;
  fetch?: typeof fetch;
  /**
   * PM3 M2: server components call the orchestrator directly, without the browser's Origin, which
   * the API requires on every state change. Their client is read-only and refuses one up front.
   */
  readOnly?: boolean;
}

const READ_METHODS = new Set(["GET", "HEAD"]);

type RequestOptions<S extends z.ZodTypeAny> = ApiRequestOptions<S>;

export function createHttpClient(opts: HttpClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function send(method: string, route: string, o: RequestOptions<z.ZodTypeAny>): Promise<Response> {
    if (opts.readOnly && !READ_METHODS.has(method.toUpperCase())) {
      throw new ApiRequestError({ status: 0, code: "internal", message: `${method} ${route}: the server-side API client is read-only; changes go through the browser.` });
    }
    const headers: Record<string, string> = { accept: "application/json", ...csrfHeaders(method) };
    let body: BodyInit | undefined;
    if (o.form) body = o.form;
    else if (o.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(o.body);
    }
    try {
      return await doFetch(`${base}${apiPath(route, o.params, o.query)}`, {
        method,
        headers,
        body,
        credentials: "same-origin",
        cache: "no-store",
        signal: o.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw ApiRequestError.unreachable(err);
    }
  }

  async function request<S extends z.ZodTypeAny>(method: string, route: string, o: RequestOptions<S> = {}): Promise<z.infer<S>> {
    const res = await send(method, route, o);
    if (!res.ok) throw await apiErrorFromResponse(res);
    if (!o.schema) return undefined as z.infer<S>;
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new ApiRequestError({ status: res.status, code: "bad_response", message: `${method} ${route} did not answer JSON.` });
    }
    const parsed = o.schema.safeParse(data);
    if (!parsed.success) {
      throw new ApiRequestError({
        status: res.status,
        code: "bad_response",
        message: `${method} ${route} answered a shape the UI does not understand.`,
        details: parsed.error.issues,
      });
    }
    return parsed.data;
  }

  return { base, send, request };
}

export type HttpClient = ReturnType<typeof createHttpClient>;

export interface HttpApiOptions extends HttpClientOptions {
  events: EventFeed;
}

/** WebApi on the orchestrator (live mode). */
export function createHttpApi(opts: HttpApiOptions): WebApi {
  const http = createHttpClient(opts);
  const { request } = http;

  const listBots = async () => (await request("GET", API_ROUTES.bots, { schema: BotsResponseSchema })).bots;
  const listRooms = async () => (await request("GET", API_ROUTES.rooms, { schema: RoomsResponseSchema })).rooms;
  const listEngines = async () => (await request("GET", API_ROUTES.engines, { schema: EnginesResponseSchema })).engines;
  const getReviewQueue = async () => (await request("GET", API_ROUTES.reviewQueue, { schema: ReviewQueueResponseSchema })).cards;
  /**
   * §11 sidebar "Chrome extension status": not connected when an engine's extension does not
   * answer (null = unknown, the engine is stopped). bridge.status events keep it live.
   */
  const chromeConnected = async () => {
    try {
      const { chrome } = await request("GET", API_ROUTES.bridges, { schema: BridgesResponseSchema });
      return chrome.every((c) => c.connected !== false);
    } catch {
      return true;
    }
  };
  const listRuns = async (q: { status?: string; limit?: number } = {}): Promise<RunRow[]> => {
    const body = await request("GET", API_ROUTES.runs, { query: { status: q.status, limit: q.limit }, schema: RunsResponseSchema });
    // PM3 S4: a run started from a saved preset carries the preset's name.
    return body.runs.map((r) => ({ ...r, presetName: body.presetNames?.[r.id] ?? null }));
  };

  return {
    mode: "live",
    events: opts.events,

    async getHealth(): Promise<HealthState> {
      let res: Response;
      try {
        res = await http.send("GET", API_ROUTES.health, {});
      } catch {
        return { ok: false, reason: "unreachable", detail: null };
      }
      // A degraded start answers 503 with the reason in the body (PM S19): read it either way.
      const parsed = HealthStatusSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) return { ok: false, reason: res.status === 502 || res.status === 504 ? "unreachable" : `http_${res.status}`, detail: null };
      return parsed.data.ok ? { ok: true, reason: null, detail: null } : { ok: false, reason: parsed.data.reason, detail: parsed.data.detail };
    },

    async getShellData() {
      const [bots, rooms, engines, cards, runs, chrome] = await Promise.all([listBots(), listRooms(), listEngines(), getReviewQueue(), listRuns(), chromeConnected()]);
      return toShellData({ bots, rooms, engines, reviewCount: cards.length, runs, chromeConnected: chrome });
    },
    async getBot(name) {
      const bot = (await listBots()).find((b) => b.name === name);
      return bot ? toBotSummary(bot) : null;
    },
    async getRoom(id) {
      const room = (await listRooms()).find((r) => r.id === id);
      return room ? toRoomSummary(room) : null;
    },
    listBots,
    listEngines,

    listRooms,
    async listMessages(roomId, o = {}) {
      return request("GET", API_ROUTES.roomMessages, {
        params: { id: roomId },
        query: { before: o.before, limit: o.limit },
        schema: MessagesResponseSchema,
      });
    },
    async sendMessage(input) {
      const body = { roomId: input.roomId, text: input.text, uploadIds: input.uploadIds ?? [] };
      return (await request("POST", API_ROUTES.chatSend, { body, schema: ChatSendResultSchema })).message;
    },
    async uploadFiles(files) {
      const form = new FormData();
      for (const f of files) form.append("files", f, f.name);
      return request("POST", API_ROUTES.uploads, { form, schema: UploadsResponseSchema });
    },
    async answerQuestion(taskId, input) {
      return request("POST", API_ROUTES.answerQuestion, { params: { taskId }, body: input, schema: AnswerQuestionResponseSchema });
    },
    async resumeTask(taskId, input = { confirmDomain: null }) {
      await request("POST", API_ROUTES.taskResume, { params: { id: taskId }, body: { confirmDomain: input.confirmDomain } });
    },
    async declineDomain(taskId) {
      await request("POST", API_ROUTES.taskDeclineDomain, { params: { id: taskId }, body: {} });
    },
    async chooseOption(input) {
      await request("POST", API_ROUTES.chatChoices, { body: input });
    },

    listRuns,
    async getRun(runId) {
      return request("GET", API_ROUTES.run, { params: { id: runId }, schema: RunDetailSchema });
    },
    async getStep(stepId) {
      return request("GET", API_ROUTES.step, { params: { id: stepId }, schema: StepDetailSchema });
    },
    async controlRun(runId, action) {
      return request("POST", API_ROUTES.runControl, { params: { id: runId }, body: { action }, schema: RunControlResponseSchema });
    },
    async rerunStep(stepId) {
      await request("POST", API_ROUTES.stepRerun, { params: { id: stepId }, body: {} });
    },
    async getTranscript(taskId) {
      try {
        return (await request("GET", API_ROUTES.taskTranscript, { params: { id: taskId }, schema: TranscriptResponseSchema })).lines;
      } catch (err) {
        // 404: the task has no saved transcript yet (it has not started); the drawer streams live lines.
        if (err instanceof ApiRequestError && err.code === "not_found") return [];
        throw err;
      }
    },

    getReviewQueue,
    async approve(jobId, input) {
      const body = { cvVersionId: input.cvVersionId, introText: input.introText, ...(input.dryRun ? { dryRun: true } : {}) };
      return request("POST", API_ROUTES.reviewApprove, { params: { jobId }, body, schema: ApproveResponseSchema });
    },
    async requestChanges(jobId, input) {
      await request("POST", API_ROUTES.reviewRequestChanges, { params: { jobId }, body: input });
    },
    async skip(jobId, input) {
      await request("POST", API_ROUTES.reviewSkip, { params: { jobId }, body: input });
    },
    async confirmInjection(jobId) {
      await request("POST", API_ROUTES.reviewConfirmInjection, { params: { jobId }, body: { confirmed: true } });
    },

    fileUrl(id, o = {}) {
      return `${http.base}${fileUrl(id, o)}`;
    },

    request,
    apiUrl(path) {
      return /^[a-z][a-z0-9+.-]*:/i.test(path) ? path : `${http.base}${path.startsWith("/") ? "" : "/"}${path}`;
    },
  };
}
