// The data seam's contract: every screen talks to the orchestrator through a WebApi. Two
// implementations: http.ts (the orchestrator, REST + SSE) and mock/ (in-memory, from the shared
// fixtures; e2e tests and `pnpm dev` without an orchestrator). Shapes are the shared API schemas;
// the few local extensions below are forward-compatible with additive server changes.
import {
  ApproveRequestSchema,
  ApproveResponseSchema,
  IdSchema,
  IsoDateTimeSchema,
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
  type RunDetail,
  type SkipRequest,
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
 * GET /health. Shared HealthSchema is `{ ok: true }`; a degraded start (PM S19) answers
 * `{ ok: false, reason, detail }`, e.g. reason `prompt_version_stale`, detail `{ bot }`.
 */
export const HealthStatusSchema = z.object({
  ok: z.boolean(),
  reason: z.string().nullable().optional(),
  detail: z.unknown().optional(),
});
export type HealthStatus = { ok: boolean; reason: string | null; detail: unknown };

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
 * UC-12 answer. The shared AnswerQuestionRequest has no `field`, but the engine answers one
 * question by field (Apply may ask several); the UI sends it, and W3a should accept it.
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
  /** Sent only when the shared ApproveRequestSchema has `dryRun` (see supportsDryRun). */
  dryRun?: boolean;
}

/**
 * Dry-run approvals (§12) are offered only once the shared contract carries `dryRun` (F2 adds it,
 * PM S2). Until then the option stays hidden, so a server that would silently drop the flag can
 * never turn a dry run into a live submission.
 */
export function supportsDryRun(schema: { shape: object } = ApproveRequestSchema): boolean {
  return "dryRun" in schema.shape;
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
  getHealth(): Promise<HealthStatus>;
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
  answerQuestion(taskId: string, input: AnswerInput): Promise<void>;
  resumeTask(taskId: string, input?: { confirmDomain: string | null }): Promise<void>;
  chooseOption(input: ChoiceRequest): Promise<void>;

  // runs (UC-22, UC-23)
  listRuns(): Promise<Run[]>;
  getRun(runId: string): Promise<RunDetail>;
  controlRun(runId: string, action: RunControlRequest["action"]): Promise<void>;
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
