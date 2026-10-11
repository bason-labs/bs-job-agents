// Chat, rooms and question answers (UC-01, UC-12, UC-15, UC-24, UC-25).
import { z } from "zod";
import { BotNameSchema, IdSchema } from "../common/primitives.js";
import { PendingQuestionSchema } from "../bots/apply.js";
import { MessageSchema, RoomSchema } from "../domain/chat.js";
import { FileRefSchema } from "./common.js";

export const ChatSendRequestSchema = z
  .object({
    roomId: IdSchema,
    text: z.string().max(20_000),
    /** Ids from POST /uploads (UC-24). */
    uploadIds: z.array(IdSchema).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.text.trim() === "" && v.uploadIds.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "type a message or attach a file" });
    }
  });
export type ChatSendRequest = z.infer<typeof ChatSendRequestSchema>;

export const ChatSendResponseSchema = z.object({ message: MessageSchema });
export type ChatSendResponse = z.infer<typeof ChatSendResponseSchema>;

export const RoomsResponseSchema = z.object({ rooms: z.array(RoomSchema) });

export const MessagesQuerySchema = z.object({
  before: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** UC-24: what a message's attachment chip shows; `file` opens it in the viewer. W3a, additive. */
export const MessageAttachmentSchema = z.object({
  id: IdSchema,
  filename: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  file: FileRefSchema,
});
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;

/** A message as GET /rooms/:id/messages returns it: the shared Message plus its attachments. */
export const ChatMessageSchema = MessageSchema.extend({ attachments: z.array(MessageAttachmentSchema).default([]) });
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const MessagesResponseSchema = z.object({ messages: z.array(ChatMessageSchema), hasMore: z.boolean() });

/** UC-15: create a group room. */
export const CreateRoomRequestSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "room names look like cv-brainstorm"),
  members: z.array(BotNameSchema).min(1),
});
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;

/**
 * UC-12 question card: answer, Skip — leave blank (optional fields only; the server
 * rejects skip for required fields), or Negotiable / Thỏa thuận (salary).
 */
export const AnswerQuestionRequestSchema = z
  .object({
    /**
     * The question card's `question.field` (W3a, additive). When omitted, the server answers the
     * question Lead asked Ba last that has no answer yet.
     */
    field: z.string().min(1).optional(),
    mode: z.enum(["answer", "skip", "negotiable"]),
    value: z.string().trim().min(1).nullable(),
    /** "remember this answer" → saved_answers. */
    remember: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === "answer" && v.value === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "type an answer" });
    }
  });
export type AnswerQuestionRequest = z.infer<typeof AnswerQuestionRequestSchema>;

/** Apply resumed (every question answered), or the next question Lead now asks (one at a time, UC-12). */
export const AnswerQuestionResponseSchema = z.object({ resumed: z.boolean(), next: PendingQuestionSchema.nullable() });
export type AnswerQuestionResponse = z.infer<typeof AnswerQuestionResponseSchema>;

/** A chip choice on a message card, e.g. "Just this run" / "Save to my criteria" (UC-21b a). */
export const ChoiceRequestSchema = z.object({ messageId: IdSchema, key: z.string().min(1), optionId: z.string().min(1) });
export type ChoiceRequest = z.infer<typeof ChoiceRequestSchema>;

// ---------------------------------------------------------------- W3a part 2 (additive)

/**
 * POST /chat/messages answers with Ba's stored message and the conversation tasks it queued (Lead's
 * chat, a consult reply, or one room reply per mentioned bot). The replies arrive as
 * `message.created` events on SSE.
 */
export const ChatSendResultSchema = z.object({ message: ChatMessageSchema, taskIds: z.array(IdSchema) });
export type ChatSendResult = z.infer<typeof ChatSendResultSchema>;

/** UC-15: one room message asks at most this many mentioned bots (the rest are named in a note). */
export const ROOM_MENTION_CAP = 5;

/** Rule 3 (PM S22): Lead's `propose_workflow` suggestion, kept for Ba. Nothing runs until he approves. */
export const WorkflowProposalStatusSchema = z.enum(["pending", "approved", "dismissed"]);
export type WorkflowProposalStatus = z.infer<typeof WorkflowProposalStatusSchema>;

const ProposalNameSchema = z.string().max(60).regex(/^[a-z][a-z0-9-]*$/, "workflow names are lowercase slugs");
const ShippedWorkflowSchema = z.enum(["job-scan", "apply-to-link", "apply-to-file"]);

/**
 * propose_workflow tool input (orchestrator MCP server). Either a preset of a shipped workflow
 * (`basedOn` + its `params`, e.g. a scan Ba keeps asking for), or a full definition in YAML.
 */
export const ProposeWorkflowInputSchema = z
  .object({
    name: ProposalNameSchema,
    description: z.string().trim().min(1).max(500),
    basedOn: ShippedWorkflowSchema.nullable().default(null),
    params: z.record(z.unknown()).nullable().default(null),
    definitionYaml: z.string().min(1).max(20_000).nullable().default(null),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.basedOn === null) === (v.definitionYaml === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["basedOn"], message: "give either basedOn (with params) or definitionYaml" });
    }
  });
export type ProposeWorkflowInput = z.infer<typeof ProposeWorkflowInputSchema>;

export const WorkflowProposalSchema = z.object({
  id: IdSchema,
  name: ProposalNameSchema,
  description: z.string(),
  basedOn: ShippedWorkflowSchema.nullable(),
  params: z.record(z.unknown()).nullable(),
  definitionYaml: z.string().nullable(),
  status: WorkflowProposalStatusSchema,
  /** The lead.chat task that proposed it. */
  taskId: IdSchema.nullable(),
  proposedAt: z.string(),
  decidedAt: z.string().nullable(),
  /** The `workflows` table version Ba's approval saved. */
  savedVersion: z.number().int().positive().nullable(),
});
export type WorkflowProposal = z.infer<typeof WorkflowProposalSchema>;

/** GET /workflow-proposals (newest first). */
export const WorkflowProposalsResponseSchema = z.object({ proposals: z.array(WorkflowProposalSchema) });

/** POST /workflow-proposals/:id/approve: saved as a new `workflows` row; nothing is started. */
export const WorkflowProposalApproveResponseSchema = z.object({
  proposal: WorkflowProposalSchema,
  workflow: z.object({ name: z.string(), version: z.number().int().positive() }),
});
