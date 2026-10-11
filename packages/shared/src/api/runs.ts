// Runs, steps and tasks (UC-22 inspect, UC-23 pause/cancel/re-run, UC-17 resume).
import { z } from "zod";
import { IdSchema } from "../common/primitives.js";
import { RunSchema, RunStatusSchema, StepSchema, TaskSchema } from "../domain/run.js";
import { StartWorkflowInputSchema } from "../workflow/params.js";

export const StartRunRequestSchema = StartWorkflowInputSchema;
export const StartRunResponseSchema = z.object({ runId: IdSchema });

export const RunControlRequestSchema = z.object({ action: z.enum(["pause", "resume", "cancel"]) });
export type RunControlRequest = z.infer<typeof RunControlRequestSchema>;

/** The run after the control; `cancel` also lists the running tasks that got the abort signal. */
export const RunControlResponseSchema = z.object({ run: RunSchema, abortedTaskIds: z.array(IdSchema) });
export type RunControlResponse = z.infer<typeof RunControlResponseSchema>;

/** GET /runs?status=&limit= (newest first). */
export const RunsQuerySchema = z.object({
  status: RunStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const RunDetailSchema = z.object({
  run: RunSchema,
  steps: z.array(StepSchema),
  tasks: z.array(TaskSchema),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

export const RunsResponseSchema = z.object({ runs: z.array(RunSchema) });

/** UC-22 step drawer. */
export const StepDetailSchema = z.object({
  step: StepSchema,
  tasks: z.array(TaskSchema),
  selfCheck: z.array(z.object({ item: z.string(), passed: z.boolean(), note: z.string().nullable() })),
  durationMs: z.number().int().nonnegative().nullable(),
});
export type StepDetail = z.infer<typeof StepDetailSchema>;

/** UC-17: Ba clicked "Done" after fixing login / CAPTCHA / Figma. Optional domain for UC-11 e. */
export const TaskResumeRequestSchema = z.object({ confirmDomain: z.string().nullable().default(null) });

// ---------------------------------------------------------------- W3a part 2 (additive)

/**
 * UC-22 step drawer transcript: GET /tasks/:id/transcript?attempt=&after=. Lines are summarised
 * and redacted by the orchestrator (no image data, no token-like values, no capability URLs) and
 * size-capped. While the task runs, poll with `after` = the last `nextAfter`.
 */
export const TranscriptQuerySchema = z.object({
  attempt: z.coerce.number().int().min(1).optional(),
  after: z.coerce.number().int().min(0).default(0),
});

export const TranscriptLineKindSchema = z.enum(["text", "tool", "tool_result", "system", "result", "runner", "other"]);
export const TranscriptLineSchema = z.object({
  /** 1-based line number in the transcript file. */
  n: z.number().int().positive(),
  kind: TranscriptLineKindSchema,
  text: z.string(),
});
export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;

export const TranscriptResponseSchema = z.object({
  taskId: IdSchema,
  attempt: z.number().int().min(1),
  /** Attempts that have a transcript, oldest first. */
  attempts: z.array(z.number().int().min(1)),
  lines: z.array(TranscriptLineSchema),
  /** Pass as `after` to get only newer lines. */
  nextAfter: z.number().int().min(0),
  /** Older lines or long texts were left out (size cap). */
  truncated: z.boolean(),
  running: z.boolean(),
});
export type TranscriptResponse = z.infer<typeof TranscriptResponseSchema>;
