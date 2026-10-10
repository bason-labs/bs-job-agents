// SSE event union (§4.2 API + SSE, §11 live updates, §10.2 rule 8 audit log).
// Every event is also written to the `events` table (id, type, payload_json, created_at) for replay.
import { z } from "zod";
import { BotNameSchema, EngineSchema, IdSchema, IsoDateTimeSchema, TrustLevelSchema } from "../common/primitives.js";
import { ApplicationOriginSchema, ApplicationStatusSchema, type SubmissionRefusalReason } from "../domain/application.js";
import { BotActivitySchema } from "../domain/bot-record.js";
import { MessageSchema } from "../domain/chat.js";
import { EnginePauseReasonSchema, EngineUsageSchema } from "../domain/engine-state.js";
import { ExportSchema } from "../domain/export.js";
import { PauseReasonSchema, RunStatusSchema, RunTriggerSchema, StepStatusSchema } from "../domain/run.js";

const base = {
  /** Monotonic event id; also the SSE `id:` for Last-Event-ID replay. */
  id: z.string().min(1),
  at: IsoDateTimeSchema,
};

const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ ...base, type: z.literal(type), ...shape }).strict();

const stepRef = {
  runId: IdSchema,
  stepId: IdSchema,
  stepKey: z.string().min(1),
  /** Job id for per-job branches. */
  branchKey: z.string().nullable(),
};

/** Why a bot action or a record was refused (§10.2 rules 1, 2, 4, 7; §9.1). Append-only. */
export const SAFETY_DENIAL_REASONS = [
  "no_token",
  "token_expired",
  "token_used",
  "wrong_job",
  "wrong_domain",
  "off_allowlist",
  "consult_mode",
  "trust_level",
  "protected_page_changed",
  "page_mismatch",
  // PM M1/M2: the trust guard's binding checks and the submission record's checks.
  "token_unused",
  "token_mismatch",
  "wrong_application",
  "wrong_cv",
  "injection_flagged",
  "application_closed",
  "sha_mismatch",
  "dry_run_mismatch",
] as const;
export const SafetyDenialReasonSchema = z.enum(SAFETY_DENIAL_REASONS);
export type SafetyDenialReason = z.infer<typeof SafetyDenialReasonSchema>;

/**
 * The `safety.denied` reason for a refused submission record (PM M1): the engine keeps the raw
 * Apply result on the task, marks the application `needs_check` and appends this event.
 */
export const SAFETY_REASON_FOR_SUBMISSION_REFUSAL = {
  token_missing: "no_token",
  token_unused: "token_unused",
  token_mismatch: "token_mismatch",
  sha_mismatch: "sha_mismatch",
  dry_run_mismatch: "dry_run_mismatch",
} as const satisfies Record<SubmissionRefusalReason, SafetyDenialReason>;

/** Map step counts for the stacked node (×N, running/queued, §11 Flow canvas). */
const MapCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const AppEventSchema = z.discriminatedUnion("type", [
  // runs
  ev("run.started", {
    runId: IdSchema,
    workflowName: z.string().min(1),
    trigger: RunTriggerSchema,
    scheduleId: IdSchema.nullable(),
  }),
  ev("run.updated", { runId: IdSchema, status: RunStatusSchema }),
  ev("run.finished", {
    runId: IdSchema,
    status: z.enum(["done", "failed", "cancelled"]),
    summary: z.string().nullable(),
  }),
  // steps
  ev("step.started", { ...stepRef, round: z.number().int().positive().nullable() }),
  ev("step.updated", {
    ...stepRef,
    status: StepStatusSchema,
    round: z.number().int().positive().nullable(),
    /** Live output preview on the node, e.g. "34 JobCandidate (21 new)". */
    preview: z.string().nullable(),
    counts: MapCountsSchema.nullable(),
  }),
  ev("step.finished", {
    ...stepRef,
    status: z.enum(["done", "failed", "skipped", "cancelled"]),
    preview: z.string().nullable(),
    error: z.string().nullable(),
  }),
  // tasks
  ev("task.started", {
    taskId: IdSchema,
    runId: IdSchema.nullable(),
    stepId: IdSchema.nullable(),
    botName: BotNameSchema,
    kind: z.string().min(1),
    engine: EngineSchema,
    attempt: z.number().int().positive(),
  }),
  ev("task.progress", {
    taskId: IdSchema,
    runId: IdSchema.nullable(),
    stepId: IdSchema.nullable(),
    botName: BotNameSchema,
    /** Derived from stream-json / exec --json lines (§5.5 step 3). */
    kind: z.enum(["text", "tool_use", "tool_result", "status"]),
    text: z.string(),
    tool: z.string().nullable(),
  }),
  ev("task.paused", { taskId: IdSchema, runId: IdSchema.nullable(), botName: BotNameSchema, reason: PauseReasonSchema }),
  ev("task.resumed", { taskId: IdSchema, runId: IdSchema.nullable(), botName: BotNameSchema }),
  ev("task.finished", {
    taskId: IdSchema,
    runId: IdSchema.nullable(),
    stepId: IdSchema.nullable(),
    botName: BotNameSchema,
    status: z.enum(["done", "failed", "interrupted"]),
    attempt: z.number().int().positive(),
    error: z.string().nullable(),
  }),
  // engines (UC-16)
  ev("engine.paused", { engine: EngineSchema, until: IsoDateTimeSchema.nullable(), reason: EnginePauseReasonSchema }),
  ev("engine.resumed", { engine: EngineSchema }),
  ev("engine.usage", { engine: EngineSchema, usage: EngineUsageSchema }),
  // review + applications
  ev("review.ready", {
    jobId: IdSchema,
    runId: IdSchema.nullable(),
    company: z.string(),
    title: z.string(),
    cvVersionIds: z.array(IdSchema),
    qaPassed: z.boolean(),
    /** QA not passed after max rounds (UC-07 a). */
    escalated: z.boolean(),
    /** factRequests or questions waiting for Ba (UC-09 a). */
    needsInput: z.boolean(),
    injectionFlagged: z.boolean(),
  }),
  ev("application.updated", {
    applicationId: IdSchema,
    jobId: IdSchema,
    status: ApplicationStatusSchema,
    origin: ApplicationOriginSchema,
  }),
  // chat
  ev("message.created", { roomId: IdSchema, message: MessageSchema }),
  ev("message.delta", { roomId: IdSchema, messageId: IdSchema, delta: z.string() }),
  // bots, schedules, bridges
  ev("bot.updated", {
    botName: BotNameSchema,
    engine: EngineSchema,
    trustLevel: TrustLevelSchema,
    enabled: z.boolean(),
    activity: BotActivitySchema,
    promotionSuggested: z.boolean(),
  }),
  ev("schedule.fired", { scheduleId: IdSchema, runId: IdSchema, catchUp: z.boolean() }),
  ev("schedule.skipped", { scheduleId: IdSchema, reason: z.enum(["overlap", "disabled", "missed"]) }),
  ev("bridge.status", { bridge: z.enum(["chrome", "figma"]), engine: EngineSchema.nullable(), connected: z.boolean() }),
  // safety + audit (§10.2 rules 7–8)
  ev("safety.denied", {
    botName: BotNameSchema,
    taskId: IdSchema.nullable(),
    action: z.string().min(1),
    reason: SafetyDenialReasonSchema,
    detail: z.string().nullable(),
  }),
  ev("export.ready", { export: ExportSchema }),
]);
export type AppEvent = z.infer<typeof AppEventSchema>;
export type AppEventType = AppEvent["type"];
export type EventOfType<T extends AppEventType> = Extract<AppEvent, { type: T }>;

export const APP_EVENT_TYPES = AppEventSchema.options.map((o) => o.shape.type.value) as AppEventType[];

export function isEventType<T extends AppEventType>(event: AppEvent, type: T): event is EventOfType<T> {
  return event.type === type;
}

/** `run.*`, `task.progress`, `*`. */
export function matchesEventPattern(type: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return type.startsWith(pattern.slice(0, -1));
  return type === pattern;
}

/** One SSE frame. JSON.stringify escapes newlines, so data stays on one line. */
export function encodeSseEvent(event: AppEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Parse and validate the `data:` of an SSE frame (web client). Throws on invalid input. */
export function decodeSseData(data: string): AppEvent {
  return AppEventSchema.parse(JSON.parse(data));
}

/** `events` table row (audit log + SSE replay). */
export const EventRecordSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  payload: z.unknown(),
  createdAt: IsoDateTimeSchema,
});
export type EventRecord = z.infer<typeof EventRecordSchema>;
