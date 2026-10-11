// Shared API shapes and routes (§4.2 REST + SSE, §11 file viewer rule).
import { z } from "zod";
import { IsoDateTimeSchema } from "../common/primitives.js";

export const ApiErrorCodeSchema = z.enum([
  "validation_failed",
  "not_found",
  "conflict",
  "forbidden",
  "already_applied",
  "engine_paused",
  "internal",
]);

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    details: z.unknown().nullable(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const OkResponseSchema = z.object({ ok: z.literal(true) });

/** Orchestrator REST routes (127.0.0.1:4100 by default, overridable with `ORCH_PORT`). `:id` segments are path params. */
export const API_ROUTES = {
  health: "/health",
  events: "/events",
  files: "/files/:id",
  chatSend: "/chat/messages",
  rooms: "/rooms",
  roomMessages: "/rooms/:id/messages",
  answerQuestion: "/questions/:taskId/answer",
  runs: "/runs",
  run: "/runs/:id",
  runControl: "/runs/:id/control",
  stepRerun: "/steps/:id/rerun",
  taskResume: "/tasks/:id/resume",
  reviewQueue: "/review",
  reviewApprove: "/review/:jobId/approve",
  reviewRequestChanges: "/review/:jobId/request-changes",
  reviewSkip: "/review/:jobId/skip",
  reviewConfirmInjection: "/review/:jobId/confirm-injection",
  criteria: "/criteria",
  criteriaVersions: "/criteria/versions",
  schedules: "/schedules",
  schedule: "/schedules/:id",
  scheduleRestore: "/schedules/:id/restore",
  scheduleRunNow: "/schedules/:id/run",
  applications: "/applications",
  application: "/applications/:id",
  applicationStatus: "/applications/:id/status",
  exports: "/exports",
  uploads: "/uploads",
  bots: "/bots",
  bot: "/bots/:name",
  engines: "/engines",
  masterCv: "/master-cv",
  savedAnswers: "/saved-answers",
  // W3a (additive)
  /** S19: running or degraded, why, and what start-up recovered. */
  status: "/status",
  /** UC-22 step drawer. */
  step: "/steps/:id",
  /** DELETE one saved answer by its normalised key (UC-12). */
  savedAnswer: "/saved-answers/:key",
  // W3a part 2 (additive)
  /** A suggestion chip on a Lead card: kept on the card, its label sent as Ba's answer (ChoiceRequest). */
  chatChoices: "/chat/choices",
  /** Rule 3: Lead's propose_workflow suggestions; Ba approves (saved, never run) or dismisses. */
  workflowProposals: "/workflow-proposals",
  workflowProposalApprove: "/workflow-proposals/:id/approve",
  workflowProposalDismiss: "/workflow-proposals/:id/dismiss",
  /** UC-22: a task attempt's redacted transcript. */
  taskTranscript: "/tasks/:id/transcript",
  /** §11 sidebar: Chrome extension status per engine (bridge.status events keep it live). */
  bridges: "/bridges",
  /** W3c handoffs (additive). */
  applicationApplyAgain: "/applications/:id/apply-again",
  botMemoryNote: "/bots/:name/memory/:noteId",
  botPromotionDismiss: "/bots/:name/promotion/dismiss",
  masterCvVersions: "/master-cv/versions",
  masterCvFactRequests: "/master-cv/fact-requests",
  masterCvFactRequestDismiss: "/master-cv/fact-requests/:id/dismiss",
  criteriaProfiles: "/criteria/profiles",
} as const;

/** GET /bridges (W3a, additive): whether each engine's Chrome extension answers; null = unknown (engine stopped). */
export const BridgesResponseSchema = z.object({
  chrome: z.array(z.object({ engine: z.enum(["claude", "codex"]), connected: z.boolean().nullable() })),
  checkedAt: IsoDateTimeSchema,
});
export type BridgesResponse = z.infer<typeof BridgesResponseSchema>;

/**
 * PM S18 (CSRF): every state-changing request (POST, PUT, PATCH, DELETE) carries this header, or the
 * orchestrator refuses it. A cross-site form cannot set a header, and a cross-origin fetch that sets
 * one needs a CORS preflight, which the orchestrator never answers. The web app reaches the API
 * through its own origin (a same-origin proxy), so the browser never makes a cross-origin call.
 */
export const CSRF_HEADER = "x-bsja-csrf";
export const CSRF_HEADER_VALUE = "1";

/**
 * PM S19: why the orchestrator runs degraded. HTTP and SSE still serve, the engine stays stopped,
 * and the UI shows the reason instead of "orchestrator unreachable".
 * - data_dir_invalid: the data folder's path has a space, comma or parenthesis, or cannot be created
 * - db_open_failed: data/app.db could not be opened or migrated
 * - schema_guard: a §9.1 immutability trigger or index is missing (openDb refused)
 * - workflows_invalid: a workflows/*.yaml file is invalid or changed without a version bump
 * - bots_invalid: a bots/<name>/bot.json is invalid or unsafe
 * - prompt_version_stale: a ROLE.md changed without a promptVersion bump
 * - engine_start_failed: any other start-up error
 */
export const DEGRADED_REASONS = [
  "data_dir_invalid",
  "db_open_failed",
  "schema_guard",
  "workflows_invalid",
  "bots_invalid",
  "prompt_version_stale",
  "engine_start_failed",
] as const;
export const DegradedReasonSchema = z.enum(DEGRADED_REASONS);
export type DegradedReason = z.infer<typeof DegradedReasonSchema>;

/** GET /health: `{ ok: true }` while the engine runs; `{ ok: false, reason, detail }` (HTTP 503) when degraded. */
export const HealthStatusSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: DegradedReasonSchema, detail: z.string() }),
]);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

/** GET /status (S19, UC-18). */
export const OrchestratorStatusSchema = z.object({
  state: z.enum(["running", "degraded"]),
  reason: DegradedReasonSchema.nullable(),
  detail: z.string().nullable(),
  startedAt: IsoDateTimeSchema,
  /** Absolute data folder (UC-13b shows it). */
  dataDir: z.string(),
  /** UC-18: what start-up recovered after a crash; null when the engine did not start. */
  recovered: z
    .object({
      requeued: z.number().int().nonnegative(),
      exhausted: z.number().int().nonnegative(),
      needsCheck: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type OrchestratorStatus = z.infer<typeof OrchestratorStatusSchema>;

/** File served for the in-app viewer; Download inside the viewer adds `?download=1`. */
export function fileUrl(id: string, opts: { download?: boolean } = {}): string {
  return `/files/${encodeURIComponent(id)}${opts.download ? "?download=1" : ""}`;
}

/** A file the viewer can open (CV PDF, screenshot, JD snapshot, export). */
export const FileKindSchema = z.enum(["cv_pdf", "screenshot", "jd_snapshot", "jd_screenshot", "upload", "export"]);
export const FileRefSchema = z.object({
  id: z.string().min(1),
  kind: FileKindSchema,
  filename: z.string().min(1),
  mime: z.string().min(1),
});
export type FileRef = z.infer<typeof FileRefSchema>;
