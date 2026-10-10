// Schedules (§7.4, UC-21, §15.2).
import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "../common/primitives.js";
import { WorkflowSlugSchema } from "../workflow/params.js";

export const DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh";
/** §15.2: weekdays 09:00 Asia/Ho_Chi_Minh. */
export const DEFAULT_SCHEDULE_CRON = "0 9 * * 1-5";

const CRON_FIELD = /^[\d*/,\-A-Za-z?LW#]+$/;

/** 5-field cron (minute hour day-of-month month day-of-week); the UI rule is "cron must have 5 fields". */
export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5 && parts.every((p) => CRON_FIELD.test(p));
}

export const CronSchema = z.string().refine(isValidCron, "cron must have 5 fields");

export const ScheduleSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1, "name is required"),
  cron: CronSchema,
  timezone: z.string().min(1),
  workflowName: WorkflowSlugSchema,
  /** null = the active Search Profile. */
  searchProfileId: IdSchema.nullable(),
  /** Per-schedule param overrides, validated against the workflow's params schema. */
  params: z.unknown(),
  enabled: z.boolean(),
  lastRunId: IdSchema.nullable(),
  nextRunAt: IsoDateTimeSchema.nullable(),
  /** Soft delete; purged after the 6 s undo window (UC-21). */
  deletedAt: IsoDateTimeSchema.nullable(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;
