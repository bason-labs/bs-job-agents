// Runs, steps and tasks (§9 `runs`, `steps`, `tasks`; UC-16/17/18/23).
import { z } from "zod";
import { BotNameSchema, EngineSchema, IdSchema, IsoDateTimeSchema } from "../common/primitives.js";
import { WorkflowSlugSchema } from "../workflow/params.js";

export const RunTriggerSchema = z.enum(["chat", "schedule", "link"]);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

export const RUN_STATUSES = ["running", "waiting", "paused", "done", "failed", "cancelled"] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  id: IdSchema,
  workflowName: WorkflowSlugSchema,
  workflowVersion: z.number().int().positive(),
  trigger: RunTriggerSchema,
  /** Validated against WORKFLOW_PARAMS_SCHEMAS[workflowName] by the engine. */
  params: z.unknown(),
  /** Search Profile version the run started with (UC-21b). */
  searchProfileVersion: z.number().int().positive().nullable(),
  scheduleId: IdSchema.nullable(),
  status: RunStatusSchema,
  createdAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
});
export type Run = z.infer<typeof RunSchema>;

/**
 * Step statuses. `waiting` = human gate or approval; `locked` = an action step before its
 * approval token exists (the locked Apply node, §11); `skipped` = e.g. company cache hit.
 */
export const STEP_STATUSES = ["pending", "running", "waiting", "locked", "paused", "done", "failed", "skipped", "cancelled"] as const;
export const StepStatusSchema = z.enum(STEP_STATUSES);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const StepSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  stepKey: z.string().min(1),
  /** Job id for per-job branches (§7.1); null for run-level steps. */
  branchKey: z.string().nullable(),
  status: StepStatusSchema,
  /** Gate round (1..maxRounds) for gate steps. */
  round: z.number().int().positive().nullable(),
  output: z.unknown(),
  error: z.string().nullable(),
  startedAt: IsoDateTimeSchema.nullable(),
  finishedAt: IsoDateTimeSchema.nullable(),
});
export type Step = z.infer<typeof StepSchema>;

export const TASK_STATUSES = ["queued", "running", "waiting_limit", "paused", "done", "failed", "interrupted"] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * Why a task waits (§10.3, UC-11, UC-16, UC-17):
 * needs_browser (Chrome/extension not connected), needs_figma (bridge not connected),
 * needs_login(site), captcha(site), usage_limit (engine paused), needs_answer (UC-12),
 * domain_confirm(site) (Apply left the approved domain, UC-11 e).
 */
export const PAUSE_REASON_CODES = [
  "needs_browser",
  "needs_figma",
  "needs_login",
  "captcha",
  "usage_limit",
  "needs_answer",
  "domain_confirm",
] as const;
export const PauseReasonCodeSchema = z.enum(PAUSE_REASON_CODES);
export type PauseReasonCode = z.infer<typeof PauseReasonCodeSchema>;

const SITE_REQUIRED: readonly PauseReasonCode[] = ["needs_login", "captcha", "domain_confirm"];

export const PauseReasonSchema = z
  .object({
    code: PauseReasonCodeSchema,
    site: z.string().min(1).nullable(),
    detail: z.string().nullable(),
  })
  .superRefine((v, ctx) => {
    if (SITE_REQUIRED.includes(v.code) && !v.site) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["site"], message: `${v.code} needs the site` });
    }
  });
export type PauseReason = z.infer<typeof PauseReasonSchema>;

/** `tasks.pause_reason` column form: `needs_login(topcv.vn)` or `needs_figma`. */
export function formatPauseReason(r: PauseReason): string {
  return r.site ? `${r.code}(${r.site})` : r.code;
}

export function parsePauseReason(text: string): PauseReason | null {
  const m = /^([a-z_]+)(?:\(([^)]+)\))?$/.exec(text.trim());
  if (!m) return null;
  const parsed = PauseReasonSchema.safeParse({ code: m[1], site: m[2] ?? null, detail: null });
  return parsed.success ? parsed.data : null;
}

export const TaskSchema = z
  .object({
    id: IdSchema,
    /** Null for consult/discussion tasks outside a run. */
    runId: IdSchema.nullable(),
    stepId: IdSchema.nullable(),
    botName: BotNameSchema,
    kind: z.string().min(1),
    input: z.unknown(),
    output: z.unknown(),
    status: TaskStatusSchema,
    pauseReason: PauseReasonSchema.nullable(),
    /** 1-based; max 2 per task (§5.5 step 6). */
    attempt: z.number().int().positive(),
    engine: EngineSchema,
    promptVersion: z.number().int().positive(),
    transcriptPath: z.string().nullable(),
    error: z.string().nullable(),
    startedAt: IsoDateTimeSchema.nullable(),
    finishedAt: IsoDateTimeSchema.nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.status === "paused" && !v.pauseReason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pauseReason"], message: "a paused task has a pause reason" });
    }
  });
export type Task = z.infer<typeof TaskSchema>;
