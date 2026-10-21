// SSE event union (§4.2 API + SSE, §11 live updates, §10.2 rule 8 audit log).
// Every event is also written to the `events` table (id, type, payload_json, created_at) for replay.
import { z } from "zod";
import { BotNameSchema, EngineSchema, IdSchema, IsoDateTimeSchema, TrustLevelSchema } from "../common/primitives.js";
import { ApplicationOriginSchema, ApplicationStatusSchema, type SubmissionRefusalReason } from "../domain/application.js";
import { BotActivitySchema } from "../domain/bot-record.js";
import { ChatMessageSchema } from "../api/chat.js";
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

const guidanceRuleEvent = {
  snapshot: z.number().int().positive(),
  runId: IdSchema.nullable(),
  ruleId: z.string().min(1),
  point: z.string(),
  previousText: z.string(),
  newText: z.string(),
  sourceIds: z.array(z.string()),
  applied: z.boolean(),
};

/** Skill self-repair (§5.5, SEC-14): a change Research proposed outside the skill, never applied. */
const NotAppliedSchema = z.object({ file: z.string(), change: z.string() }).strict();
const skillRepairRef = { repairId: IdSchema, source: z.string().min(1), trigger: z.string() };

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
  // PM §7 W2a: a dry-run Apply reported `submitted`; it may really have submitted (needs_check).
  "dry_run_submitted",
  // §6.2: the Figma guard hook blocked a call that reached outside the Drafts page.
  "protected_page_blocked",
  // Live run 1 (F5): the Figma guard blocked a call and the protected pages were unchanged after
  // the task: prevention that worked. Informational only (never fails the task, never demotes).
  "figma_guard_blocked",
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
    /** PM2 S16 (additive): the company research failed for good, so CV tailored without a profile. */
    companyMissing: z.boolean().optional(),
  }),
  ev("application.updated", {
    applicationId: IdSchema,
    jobId: IdSchema,
    status: ApplicationStatusSchema,
    origin: ApplicationOriginSchema,
  }),
  /** UC-07 b (PM2 S2): Ba confirmed a job QA flagged for a suspected injection; Apply may run for it. */
  ev("injection.confirmed", { jobId: IdSchema, runId: IdSchema.nullable() }),
  // chat
  // F8: the message carries its attachments (name, mime, size, file id), like GET /rooms/:id/messages.
  ev("message.created", { roomId: IdSchema, message: ChatMessageSchema }),
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
  /**
   * Additive (owner request 2026-10-11): data/master-cv.yaml has a new version: Ba saved it, facts
   * drafted from his words were added (taskId = the cv.fact_draft task), or he undid that.
   * CV auto-extend (additive): facts derived from his facts were added (facts_derived; taskId = the
   * cv.derive task, null for the table), he undid such an addition, or kept a flagged fact.
   */
  /**
   * CV guidance (additive, REQ-36, SEC-24): one entry per rule a committed snapshot added or changed:
   * the rule, its previous text (empty when added), its new text and its source ids. Never page text,
   * tokens or contact data. `applied` is false only for a change whose commit failed (SEC-24.AC-3).
   */
  ev("guidance.rule_added", guidanceRuleEvent),
  ev("guidance.rule_changed", guidanceRuleEvent),
  /** CV guidance (additive, §5.4): one per refresh: counts and reasons only, no page text. */
  ev("guidance.refresh", {
    runId: IdSchema.nullable(),
    outcome: z.enum(["unchanged", "updated", "failed", "used_other_run"]),
    snapshot: z.number().int().positive().nullable(),
    pagesChecked: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    draftsAccepted: z.number().int().nonnegative(),
    draftsRejected: z.number().int().nonnegative(),
    rulesChanged: z.number().int().nonnegative(),
    discovery: z.boolean(),
    extraction: z.boolean(),
    /** Short reasons (failed pages, rejected drafts), no page text. */
    reasons: z.array(z.string()),
    error: z.string().nullable(),
  }),
  /**
   * Skill self-repair (additive, AD-7, REQ-11, SEC-14). progress: a repair is queued, drafting or
   * running its validation scan. adopted: written before the file is replaced, with the text in force
   * before (previousText) and the new text; `path` is the one file that changes. not_adopted: the
   * screen, the validation or the write failed; the skill is unchanged (draft: what was tried, or
   * null). restored: Ba put back the text in force before an adopted repair. paused: 3 attempts in a
   * row were not adopted. Never page text beyond the skill, never a token.
   */
  ev("skill_repair.progress", { ...skillRepairRef, status: z.enum(["queued", "drafting", "validating"]) }),
  ev("skill_repair.adopted", { ...skillRepairRef, path: z.string(), previousText: z.string(), newText: z.string(), notApplied: z.array(NotAppliedSchema) }),
  ev("skill_repair.not_adopted", { ...skillRepairRef, reason: z.string(), draft: z.string().nullable(), notApplied: z.array(NotAppliedSchema) }),
  ev("skill_repair.restored", { ...skillRepairRef, path: z.string(), previousText: z.string(), newText: z.string() }),
  /** SEC-14 (QA L1): a restore logged first whose file write then failed; the skill is unchanged. */
  ev("skill_repair.restore_failed", { ...skillRepairRef, reason: z.string() }),
  ev("skill_repair.paused", { source: z.string().min(1), failures: z.number().int().positive() }),
  /**
   * Skill self-repair §5.8 (additive): a board's API path broke (404/410 on a listed endpoint, a
   * response the mapper rejects, or items with no valid posting) and the run fell back to the browser;
   * or it works again. Method, host and path only, never a query or a header.
   */
  ev("source_api.changed", { source: z.string().min(1), method: z.enum(["GET", "POST"]).nullable(), host: z.string().nullable(), path: z.string().nullable(), reason: z.string() }),
  ev("source_api.recovered", { source: z.string().min(1) }),
  ev("master_cv.updated", {
    version: z.number().int().positive(),
    change: z.enum(["saved", "facts_added", "undo", "facts_derived", "derived_undo", "derived_keep"]),
    factIds: z.array(z.string()),
    taskId: IdSchema.nullable(),
  }),
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
