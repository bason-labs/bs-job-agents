// The data seam's contract: every screen talks to the orchestrator through a WebApi. Two
// implementations: http.ts (the orchestrator, REST + SSE) and mock/ (in-memory, from the shared
// fixtures; e2e tests and `pnpm dev` without an orchestrator). Shapes are the shared API schemas
// (no local extensions: lib/api/parity.test.ts fails on drift).
import type {
  AnswerQuestionResponse,
  AppEvent,
  ApproveResponse,
  TranscriptLine,
  BotView,
  ChatSendRequest,
  ChoiceRequest,
  Engine,
  EngineStatus,
  Message,
  RequestChangesRequest,
  ReviewCard,
  Room,
  Run,
  RunControlRequest,
  RunControlResponse,
  RunDetail,
  RunStatus,
  SkipRequest,
  StepDetail,
  UploadsResponse,
} from "@bs-job-agents/shared";
import type { z } from "zod";
import type { QueryValue } from "./routes";
import type { BotSummary, RoomSummary, ShellData } from "./types";

/** A run as the Flows list shows it: PM3 S4 adds the saved preset it was started from (GET /runs presetNames). */
export type RunRow = Run & { presetName?: string | null };

export type ApiMode = "live" | "mock";

// ---------------------------------------------------------------- any route

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One call to an API_ROUTES entry: path params, query, a JSON body (or a form) and the response schema. */
export interface ApiRequestOptions<S extends z.ZodTypeAny = z.ZodTypeAny> {
  params?: Record<string, string>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  form?: FormData;
  /** The shared response schema; without one the call resolves to undefined. */
  schema?: S;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------- live events

export type FeedStatus = "idle" | "connecting" | "open" | "reconnecting";
export type EventListener = (event: AppEvent) => void;

/** The SSE stream (§11 live updates). One connection per tab, shared by every subscriber. */
export interface EventFeed {
  subscribe(listener: EventListener): () => void;
  getStatus(): FeedStatus;
  onStatus(listener: (status: FeedStatus) => void): () => void;
}

// ---------------------------------------------------------------- local schemas

/**
 * What the shell knows about the orchestrator: the shared /health body (PM S19: a degraded start
 * answers 503 `{ ok: false, reason, detail }`), plus the UI's own `unreachable` and `api_error`.
 */
export interface HealthState {
  ok: boolean;
  reason: string | null;
  detail: string | null;
}

/**
 * POST /review/:jobId/approve: the shared ApproveResponse (`applicationId` null without an apply
 * link, §7.3b; `reapproval` true when it replaced a denied or expired token).
 */
export type ApproveResult = ApproveResponse;

/** A live transcript line from a `task.progress` event (the step drawer streams these, UC-22). */
export type ProgressLine = Pick<Extract<AppEvent, { type: "task.progress" }>, "at" | "kind" | "text" | "tool">;

// ---------------------------------------------------------------- inputs

/**
 * UC-12 answer: the shared AnswerQuestionRequest plus the card's `question.field` (Apply may ask
 * several questions; the field says which one this answers).
 */
export interface AnswerInput {
  field: string;
  mode: "answer" | "skip" | "negotiable";
  value: string | null;
  remember: boolean;
}

export interface ApproveInput {
  cvVersionId: string;
  /** null = Apply writes the intro from the master CV (UC-08 b, PM FYI e). */
  introText: string | null;
  /** §12 dry-run acceptance: fill and screenshot, never submit (sent only when true). */
  dryRun?: boolean;
}

export interface RunsQuery {
  status?: RunStatus;
  limit?: number;
}

export interface MessagesPage {
  messages: Message[];
  hasMore: boolean;
}

export type SendMessageInput = Pick<ChatSendRequest, "roomId" | "text"> & { uploadIds?: string[] };

// ---------------------------------------------------------------- the API

export interface WebApi {
  readonly mode: ApiMode;
  readonly events: EventFeed;

  // shell
  /** Never throws: an unreachable orchestrator is `{ ok: false, reason: "unreachable" }`. */
  getHealth(): Promise<HealthState>;
  /** Sidebar + top bar (bots, rooms, usage, review count, active run). */
  getShellData(): Promise<ShellData>;
  getBot(name: string): Promise<BotSummary | null>;
  getRoom(id: string): Promise<RoomSummary | null>;
  listBots(): Promise<BotView[]>;
  listEngines(): Promise<EngineStatus[]>;
  /** "Resume now" on the paused banner: lift a usage-limit pause early (POST /engines/:engine/resume). */
  resumeEngine(engine: Engine): Promise<void>;

  // chat (UC-01, UC-12, UC-17, UC-24, UC-25)
  listRooms(): Promise<Room[]>;
  listMessages(roomId: string, opts?: { before?: string; limit?: number }): Promise<MessagesPage>;
  sendMessage(input: SendMessageInput): Promise<Message>;
  uploadFiles(files: File[]): Promise<UploadsResponse>;
  /** Apply resumed, or the next question Lead now asks (one at a time). */
  answerQuestion(taskId: string, input: AnswerInput): Promise<AnswerQuestionResponse>;
  resumeTask(taskId: string, input?: { confirmDomain: string | null }): Promise<void>;
  /** UC-11 e "Don't allow": Apply stops instead of continuing on the new site (POST /tasks/:id/decline-domain). */
  declineDomain(taskId: string): Promise<void>;
  chooseOption(input: ChoiceRequest): Promise<void>;

  // runs (UC-22, UC-23)
  listRuns(query?: RunsQuery): Promise<RunRow[]>;
  getRun(runId: string): Promise<RunDetail>;
  /** UC-22 step drawer detail (GET /steps/:id). */
  getStep(stepId: string): Promise<StepDetail>;
  controlRun(runId: string, action: RunControlRequest["action"]): Promise<RunControlResponse>;
  rerunStep(stepId: string): Promise<void>;
  /** UC-22: the saved transcript of the task's latest attempt (shared TranscriptResponse lines); [] when none yet. */
  getTranscript(taskId: string): Promise<TranscriptLine[]>;

  // review (UC-07, UC-08, UC-09, UC-10)
  getReviewQueue(): Promise<ReviewCard[]>;
  approve(jobId: string, input: ApproveInput): Promise<ApproveResult>;
  requestChanges(jobId: string, input: RequestChangesRequest): Promise<void>;
  skip(jobId: string, input: SkipRequest): Promise<void>;
  confirmInjection(jobId: string): Promise<void>;

  /** URL the in-app viewer loads (Download inside the viewer adds `download`). */
  fileUrl(id: string, opts?: { download?: boolean }): string;

  // any route (the W3c screens' adapters in components/<area>/data.ts)
  /**
   * Any API_ROUTES call by its template (`API_ROUTES.application` + `params: { id }`), validated
   * with `schema`; failures are ApiRequestError with the server's code and `details.reason`.
   */
  request<S extends z.ZodTypeAny = z.ZodTypeAny>(method: HttpMethod, route: string, opts?: ApiRequestOptions<S>): Promise<z.infer<S>>;
  /** An orchestrator path the API answered with (an export's `downloadUrl`) as a URL this browser can open. */
  apiUrl(path: string): string;
}
