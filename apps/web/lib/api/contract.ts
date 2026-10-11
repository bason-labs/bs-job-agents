// The data seam's contract: every screen talks to the orchestrator through a WebApi. Two
// implementations: http.ts (the orchestrator, REST + SSE) and mock/ (in-memory, from the shared
// fixtures; e2e tests and `pnpm dev` without an orchestrator). Shapes are the shared API schemas;
// the few local extensions below are forward-compatible with additive server changes.
import {
  ApproveRequestSchema,
  ApproveResponseSchema,
  IdSchema,
  IsoDateTimeSchema,
  type AnswerQuestionResponse,
  type AppEvent,
  type BotView,
  type ChatSendRequest,
  type ChoiceRequest,
  type EngineStatus,
  type Message,
  type RequestChangesRequest,
  type ReviewCard,
  type Room,
  type Run,
  type RunControlRequest,
  type RunControlResponse,
  type RunDetail,
  type RunStatus,
  type SkipRequest,
  type StepDetail,
  type UploadsResponse,
} from "@bs-job-agents/shared";
import { z } from "zod";
import type { BotSummary, RoomSummary, ShellData } from "./types";

export type ApiMode = "live" | "mock";

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
 * POST /review/:jobId/approve. F2/S2 make `applicationId` nullable (no apply link, §7.3b) and the
 * engine reports `reapproval` (a new token for the same application after a denial or expiry).
 */
export const ApproveResultSchema = ApproveResponseSchema.extend({
  applicationId: IdSchema.nullable(),
  reapproval: z.boolean().optional().default(false),
});
export type ApproveResult = z.infer<typeof ApproveResultSchema>;

/** One transcript line (the shape of a `task.progress` event), for the step drawer (UC-22). */
export const TranscriptLineSchema = z.object({
  at: IsoDateTimeSchema,
  kind: z.enum(["text", "tool_use", "tool_result", "status"]),
  text: z.string(),
  tool: z.string().nullable(),
});
export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;
export const TranscriptResponseSchema = z.object({ lines: z.array(TranscriptLineSchema) });

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
  /** Sent only when supportsDryRun says the backend takes it. */
  dryRun?: boolean;
}

/**
 * Dry-run approvals (§12): the mock takes them; the orchestrator once the shared contract carries
 * `dryRun` (W3a part 2; part 1 refuses the flag with 400, so it can never turn into a live one).
 */
export function supportsDryRun(mode: ApiMode, schema: { shape: object } = ApproveRequestSchema): boolean {
  return mode === "mock" || "dryRun" in schema.shape;
}

/** POST /review/:jobId/confirm-injection arrives with W3a part 2; the mock has it now. */
export const supportsConfirmInjection = (mode: ApiMode) => mode === "mock";

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

  // chat (UC-01, UC-12, UC-17, UC-24, UC-25)
  listRooms(): Promise<Room[]>;
  listMessages(roomId: string, opts?: { before?: string; limit?: number }): Promise<MessagesPage>;
  sendMessage(input: SendMessageInput): Promise<Message>;
  uploadFiles(files: File[]): Promise<UploadsResponse>;
  /** Apply resumed, or the next question Lead now asks (one at a time). */
  answerQuestion(taskId: string, input: AnswerInput): Promise<AnswerQuestionResponse>;
  resumeTask(taskId: string, input?: { confirmDomain: string | null }): Promise<void>;
  chooseOption(input: ChoiceRequest): Promise<void>;

  // runs (UC-22, UC-23)
  listRuns(query?: RunsQuery): Promise<Run[]>;
  getRun(runId: string): Promise<RunDetail>;
  /** UC-22 step drawer detail (GET /steps/:id). */
  getStep(stepId: string): Promise<StepDetail>;
  controlRun(runId: string, action: RunControlRequest["action"]): Promise<RunControlResponse>;
  rerunStep(stepId: string): Promise<void>;
  getTranscript(taskId: string): Promise<TranscriptLine[]>;

  // review (UC-07, UC-08, UC-09, UC-10)
  getReviewQueue(): Promise<ReviewCard[]>;
  approve(jobId: string, input: ApproveInput): Promise<ApproveResult>;
  requestChanges(jobId: string, input: RequestChangesRequest): Promise<void>;
  skip(jobId: string, input: SkipRequest): Promise<void>;
  confirmInjection(jobId: string): Promise<void>;

  /** URL the in-app viewer loads (Download inside the viewer adds `download`). */
  fileUrl(id: string, opts?: { download?: boolean }): string;
}
