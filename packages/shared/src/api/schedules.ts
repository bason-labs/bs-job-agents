// Schedules screen (UC-21, §11 Schedules modal editor).
import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "../common/primitives.js";
import { CronSchema, DEFAULT_TIMEZONE, ScheduleSchema } from "../domain/schedule.js";
import { WorkflowSlugSchema } from "../workflow/params.js";

const scheduleFields = {
  name: z.string().trim().min(1, "name is required"),
  cron: CronSchema,
  timezone: z.string().min(1).default(DEFAULT_TIMEZONE),
  workflowName: WorkflowSlugSchema.default("job-scan"),
  searchProfileId: IdSchema.nullable(),
  params: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true),
};

export const ScheduleCreateRequestSchema = z.object(scheduleFields).strict();
export type ScheduleCreateRequest = z.infer<typeof ScheduleCreateRequestSchema>;

export const ScheduleUpdateRequestSchema = z
  .object({
    name: scheduleFields.name,
    cron: scheduleFields.cron,
    timezone: z.string().min(1),
    workflowName: WorkflowSlugSchema,
    searchProfileId: scheduleFields.searchProfileId,
    params: z.record(z.unknown()),
    enabled: z.boolean(),
  })
  .partial()
  .strict();
export type ScheduleUpdateRequest = z.infer<typeof ScheduleUpdateRequestSchema>;

/** Row view: next run time and last result (UC-21). */
export const ScheduleViewSchema = ScheduleSchema.extend({
  lastResult: z.string().nullable(),
});
export type ScheduleView = z.infer<typeof ScheduleViewSchema>;

export const SchedulesResponseSchema = z.object({ schedules: z.array(ScheduleViewSchema) });

/** Soft delete with a 6 s Undo (UC-21). */
export const ScheduleDeleteResponseSchema = z.object({ deletedAt: IsoDateTimeSchema, undoUntil: IsoDateTimeSchema });

export const ScheduleRunNowResponseSchema = z.discriminatedUnion("started", [
  z.object({ started: z.literal(true), runId: IdSchema }),
  z.object({ started: z.literal(false), reason: z.literal("overlap") }),
]);

/** Modal "Repeat" options → cron (time in Asia/Ho_Chi_Minh). */
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const ScheduleRepeatSchema = z.discriminatedUnion("freq", [
  z.object({ freq: z.literal("weekdays"), time: z.string() }),
  z.object({ freq: z.literal("daily"), time: z.string() }),
  z.object({ freq: z.literal("weekly"), time: z.string(), day: z.enum(WEEKDAYS) }),
  z.object({ freq: z.literal("custom"), time: z.string(), cron: CronSchema }),
]);
export type ScheduleRepeat = z.infer<typeof ScheduleRepeatSchema>;

export function repeatToCron(repeat: ScheduleRepeat): string {
  const r = ScheduleRepeatSchema.parse(repeat);
  if (r.freq === "custom") return r.cron;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(r.time);
  if (!m) throw new Error(`invalid time ${r.time}; expected HH:MM`);
  const [hh, mm] = [Number(m[1]), Number(m[2])];
  const dow = r.freq === "weekdays" ? "1-5" : r.freq === "daily" ? "*" : String(WEEKDAYS.indexOf(r.day));
  return `${mm} ${hh} * * ${dow}`;
}
