// The REST contract in one table (Phase 3 QA): for every API_ROUTES entry, the methods the
// orchestrator serves and, per method, the shared schemas of its JSON body, query and response.
// The orchestrator's routes, the web app's http client and its mock backend are checked against
// this table by parity tests (apps/orchestrator/src/api/contract-parity.test.ts,
// apps/web/lib/api/parity.test.ts), so a route or schema that drifts on one side fails a test.
// The type makes TypeScript refuse an API_ROUTES entry that has no row here.
import type { z } from "zod";
import { MasterCvSchema } from "../domain/master-cv.js";
import { RoomSchema } from "../domain/chat.js";
import {
  ApplicationDetailSchema,
  ApplicationStatusChangeRequestSchema,
  ApplicationStatusChangeResponseSchema,
  ApplicationsResponseSchema,
  ApplyAgainResponseSchema,
  ExportRequestSchema,
  ExportResponseSchema,
  ExportsResponseSchema,
} from "./applications.js";
import {
  BotUpdateRequestSchema,
  BotViewSchema,
  BotsResponseSchema,
  EnginesResponseSchema,
  FactRequestsResponseSchema,
  MasterCvUpdateRequestSchema,
  MasterCvVersionsResponseSchema,
  SavedAnswersResponseSchema,
} from "./bots.js";
import {
  AnswerQuestionRequestSchema,
  AnswerQuestionResponseSchema,
  ChatSendRequestSchema,
  ChatSendResultSchema,
  ChoiceRequestSchema,
  CreateRoomRequestSchema,
  MessagesQuerySchema,
  MessagesResponseSchema,
  RoomsResponseSchema,
  WorkflowProposalApproveResponseSchema,
  WorkflowProposalSchema,
  WorkflowProposalsResponseSchema,
} from "./chat.js";
import { API_ROUTES, BridgesResponseSchema, HealthStatusSchema, OkResponseSchema, OrchestratorStatusSchema } from "./common.js";
import { CriteriaResponseSchema, CriteriaUpdateRequestSchema, CriteriaVersionsResponseSchema, SearchProfilesResponseSchema } from "./criteria.js";
import {
  ApproveRequestSchema,
  ApproveResponseSchema,
  ConfirmInjectionRequestSchema,
  RequestChangesRequestSchema,
  ReviewQueueResponseSchema,
  SkipRequestSchema,
} from "./review.js";
import {
  RunControlRequestSchema,
  RunControlResponseSchema,
  RunDetailSchema,
  RunsQuerySchema,
  RunsResponseSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
  StepDetailSchema,
  TaskResumeRequestSchema,
  TranscriptQuerySchema,
  TranscriptResponseSchema,
} from "./runs.js";
import {
  ScheduleCreateRequestSchema,
  ScheduleDeleteResponseSchema,
  ScheduleRunNowResponseSchema,
  ScheduleUpdateRequestSchema,
  ScheduleViewSchema,
  SchedulesResponseSchema,
} from "./schedules.js";
import { UploadsResponseSchema } from "./uploads.js";

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ApiRouteKey = keyof typeof API_ROUTES;

export interface ApiEndpoint {
  /** The JSON body's schema; null for none (or `multipart` for the upload form). */
  body: z.ZodTypeAny | "multipart" | null;
  /** The query string's schema; null for none. */
  query: z.ZodTypeAny | null;
  /** The JSON response's schema; `stream` for SSE and `file` for a file download. */
  response: z.ZodTypeAny | "stream" | "file";
}

const ep = (response: ApiEndpoint["response"], body: ApiEndpoint["body"] = null, query: z.ZodTypeAny | null = null): ApiEndpoint => ({ body, query, response });

export const API_CONTRACT = {
  health: { GET: ep(HealthStatusSchema) },
  events: { GET: ep("stream") },
  files: { GET: ep("file") },
  chatSend: { POST: ep(ChatSendResultSchema, ChatSendRequestSchema) },
  rooms: { GET: ep(RoomsResponseSchema), POST: ep(RoomSchema, CreateRoomRequestSchema) },
  roomMessages: { GET: ep(MessagesResponseSchema, null, MessagesQuerySchema) },
  answerQuestion: { POST: ep(AnswerQuestionResponseSchema, AnswerQuestionRequestSchema) },
  runs: { GET: ep(RunsResponseSchema, null, RunsQuerySchema), POST: ep(StartRunResponseSchema, StartRunRequestSchema) },
  run: { GET: ep(RunDetailSchema) },
  runControl: { POST: ep(RunControlResponseSchema, RunControlRequestSchema) },
  stepRerun: { POST: ep(OkResponseSchema) },
  taskResume: { POST: ep(OkResponseSchema, TaskResumeRequestSchema) },
  reviewQueue: { GET: ep(ReviewQueueResponseSchema) },
  reviewApprove: { POST: ep(ApproveResponseSchema, ApproveRequestSchema) },
  reviewRequestChanges: { POST: ep(OkResponseSchema, RequestChangesRequestSchema) },
  reviewSkip: { POST: ep(OkResponseSchema, SkipRequestSchema) },
  reviewConfirmInjection: { POST: ep(OkResponseSchema, ConfirmInjectionRequestSchema) },
  criteria: { GET: ep(CriteriaResponseSchema), PUT: ep(CriteriaResponseSchema, CriteriaUpdateRequestSchema) },
  criteriaVersions: { GET: ep(CriteriaVersionsResponseSchema) },
  schedules: { GET: ep(SchedulesResponseSchema), POST: ep(ScheduleViewSchema, ScheduleCreateRequestSchema) },
  schedule: { GET: ep(ScheduleViewSchema), PATCH: ep(ScheduleViewSchema, ScheduleUpdateRequestSchema), DELETE: ep(ScheduleDeleteResponseSchema) },
  scheduleRestore: { POST: ep(ScheduleViewSchema) },
  scheduleRunNow: { POST: ep(ScheduleRunNowResponseSchema) },
  applications: { GET: ep(ApplicationsResponseSchema) },
  application: { GET: ep(ApplicationDetailSchema) },
  applicationStatus: { POST: ep(ApplicationStatusChangeResponseSchema, ApplicationStatusChangeRequestSchema) },
  exports: { GET: ep(ExportsResponseSchema), POST: ep(ExportResponseSchema, ExportRequestSchema) },
  uploads: { POST: ep(UploadsResponseSchema, "multipart") },
  bots: { GET: ep(BotsResponseSchema) },
  bot: { GET: ep(BotViewSchema), PATCH: ep(BotViewSchema, BotUpdateRequestSchema) },
  engines: { GET: ep(EnginesResponseSchema) },
  masterCv: { GET: ep(MasterCvSchema), PUT: ep(MasterCvSchema, MasterCvUpdateRequestSchema) },
  savedAnswers: { GET: ep(SavedAnswersResponseSchema) },
  status: { GET: ep(OrchestratorStatusSchema) },
  step: { GET: ep(StepDetailSchema) },
  savedAnswer: { DELETE: ep(OkResponseSchema) },
  chatChoices: { POST: ep(ChatSendResultSchema, ChoiceRequestSchema) },
  workflowProposals: { GET: ep(WorkflowProposalsResponseSchema) },
  workflowProposalApprove: { POST: ep(WorkflowProposalApproveResponseSchema) },
  workflowProposalDismiss: { POST: ep(WorkflowProposalSchema) },
  taskTranscript: { GET: ep(TranscriptResponseSchema, null, TranscriptQuerySchema) },
  bridges: { GET: ep(BridgesResponseSchema) },
  applicationApplyAgain: { POST: ep(ApplyAgainResponseSchema) },
  botMemoryNote: { DELETE: ep(BotViewSchema) },
  botPromotionDismiss: { POST: ep(BotViewSchema) },
  masterCvVersions: { GET: ep(MasterCvVersionsResponseSchema) },
  masterCvFactRequests: { GET: ep(FactRequestsResponseSchema) },
  masterCvFactRequestDismiss: { POST: ep(OkResponseSchema) },
  criteriaProfiles: { GET: ep(SearchProfilesResponseSchema) },
  taskDeclineDomain: { POST: ep(OkResponseSchema) },
  engineResume: { POST: ep(OkResponseSchema) },
} as const satisfies { [K in ApiRouteKey]: Partial<Record<ApiMethod, ApiEndpoint>> };

/** Every (method, route) pair of the contract, e.g. `{ key: "bot", method: "PATCH", path: "/bots/:name", … }`. */
export function apiEndpoints(): Array<{ key: ApiRouteKey; method: ApiMethod; path: string } & ApiEndpoint> {
  return (Object.keys(API_CONTRACT) as ApiRouteKey[]).flatMap((key) =>
    Object.entries(API_CONTRACT[key] as Partial<Record<ApiMethod, ApiEndpoint>>).map(([method, e]) => ({ key, method: method as ApiMethod, path: API_ROUTES[key], ...e! })),
  );
}
