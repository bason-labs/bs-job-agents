// Lead bot output (§5.2 Lead): `LeadOutput { reply, actions[] }`.
// Lead acts only through orchestrator MCP tools (rule 5); `actions` is the trace of
// what it did, which the chat renders as the delegation trace (Lead → @Bot: task · status).
import { z } from "zod";
import { BotNameSchema, CurrencySchema, SearchSourceSchema, SenioritySchema, WorkModeSchema } from "../common/primitives.js";
import { WorkflowSlugSchema } from "../workflow/params.js";
import { botEnvelopeShape } from "./self-check.js";

const term = z.string().trim().min(1);

/** Words to add to and remove from one list field of the Search Profile; null = unchanged. */
const ListEditSchema = z
  .strictObject({ add: z.array(term), remove: z.array(term) })
  .nullable()
  .describe("null leaves this list as it is");

/**
 * PM3 M3 (UC-21b a): a change to Ba's saved search criteria (§7.5), as a delta on the active
 * profile. Every field null = unchanged. The orchestrator validates it like PUT /criteria and saves
 * it only when Ba clicks "Save to my criteria".
 */
export const CriteriaChangesSchema = z.strictObject({
  roles: ListEditSchema,
  locations: ListEditSchema,
  includeKeywords: ListEditSchema,
  excludeKeywords: ListEditSchema,
  excludeCompanies: ListEditSchema,
  companyTypes: ListEditSchema,
  workModes: z.array(WorkModeSchema).nullable().describe("The new full list; null = unchanged"),
  seniority: z.array(SenioritySchema).nullable().describe("The new full list; null = unchanged"),
  sources: z.array(SearchSourceSchema).nullable().describe("The new full list; null = unchanged"),
  minSalary: z
    .strictObject({ amount: z.number().int().nonnegative().nullable().describe("null removes the floor"), currency: CurrencySchema.nullable() })
    .nullable()
    .describe("null = unchanged"),
  maxJobs: z.number().int().min(1).max(50).nullable(),
  fitThreshold: z.number().int().min(0).max(100).nullable(),
});
export type CriteriaChanges = z.infer<typeof CriteriaChangesSchema>;

export const PROPOSED_SCHEDULE_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** PM3 S1 (UC-21, §7.4 "or via Lead"): a scheduled job scan Ba creates with one click. */
export const ScheduleProposalSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).describe("Short schedule name, e.g. Weekday morning scan"),
  repeat: z.enum(["weekdays", "daily", "weekly"]),
  day: z.enum(PROPOSED_SCHEDULE_DAYS).nullable().describe("Day of the week for weekly; null otherwise"),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .describe("HH:MM, 24-hour, Asia/Ho_Chi_Minh"),
  searchProfileId: z.string().nullable().describe("null = Ba's active search criteria"),
});
export type ScheduleProposal = z.infer<typeof ScheduleProposalSchema>;

export const LeadActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start_workflow"),
    workflow: WorkflowSlugSchema.describe("A shipped workflow (job-scan, apply-to-link, apply-to-file) or a saved preset's name"),
    runId: z.string().nullable().describe("Run id returned by start_workflow"),
    summary: z.string().min(1).describe("One line for the delegation trace"),
  }),
  z.strictObject({
    type: z.literal("create_task"),
    bot: BotNameSchema,
    kind: z.string().min(1),
    taskId: z.string().nullable(),
    summary: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("ask_user"),
    question: z.string().min(1).describe("One clarifying question (UC-01 a)"),
    choices: z.array(z.string().min(1)).describe("Suggested answers shown as chips; empty for free text"),
  }),
  z.strictObject({
    type: z.literal("propose_workflow"),
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    description: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("answer_from_data"),
    source: z.string().min(1).describe("What stored data answered the question, e.g. 'applications'"),
  }),
  // PM3 M3 / S1: proposals, not tool calls. The orchestrator checks each one and shows Ba a card;
  // only Ba's click saves the criteria or creates the schedule (rule 5: Lead stays at six tools).
  z.strictObject({
    type: z.literal("propose_criteria_change"),
    changes: CriteriaChangesSchema,
  }),
  z.strictObject({
    type: z.literal("propose_schedule"),
    schedule: ScheduleProposalSchema,
  }),
]);
export type LeadAction = z.infer<typeof LeadActionSchema>;

export const LeadOutputSchema = z.strictObject({
  reply: z.string().min(1),
  actions: z.array(LeadActionSchema),
  ...botEnvelopeShape,
});
export type LeadOutput = z.infer<typeof LeadOutputSchema>;
