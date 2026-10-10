// Chat, rooms and question answers (UC-01, UC-12, UC-15, UC-24, UC-25).
import { z } from "zod";
import { BotNameSchema, IdSchema } from "../common/primitives.js";
import { MessageSchema, RoomSchema } from "../domain/chat.js";

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

export const MessagesResponseSchema = z.object({ messages: z.array(MessageSchema), hasMore: z.boolean() });

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

/** A chip choice on a message card, e.g. "Just this run" / "Save to my criteria" (UC-21b a). */
export const ChoiceRequestSchema = z.object({ messageId: IdSchema, key: z.string().min(1), optionId: z.string().min(1) });
export type ChoiceRequest = z.infer<typeof ChoiceRequestSchema>;
