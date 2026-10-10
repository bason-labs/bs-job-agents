// Lead bot output (§5.2 Lead): `LeadOutput { reply, actions[] }`.
// Lead acts only through orchestrator MCP tools (rule 5); `actions` is the trace of
// what it did, which the chat renders as the delegation trace (Lead → @Bot: task · status).
import { z } from "zod";
import { BotNameSchema } from "../common/primitives.js";
import { WorkflowNameSchema } from "../workflow/params.js";
import { botEnvelopeShape } from "./self-check.js";

export const LeadActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start_workflow"),
    workflow: WorkflowNameSchema,
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
]);
export type LeadAction = z.infer<typeof LeadActionSchema>;

export const LeadOutputSchema = z.strictObject({
  reply: z.string().min(1),
  actions: z.array(LeadActionSchema),
  ...botEnvelopeShape,
});
export type LeadOutput = z.infer<typeof LeadOutputSchema>;
