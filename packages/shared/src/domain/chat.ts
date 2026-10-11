// Rooms and messages (§9 `rooms` / `room_members` / `messages`; UC-01, UC-15, UC-24, UC-25).
import { z } from "zod";
import { BotNameSchema, IdSchema, IsoDateTimeSchema } from "../common/primitives.js";
import { PendingQuestionSchema } from "../bots/apply.js";

/** lead = the Lead chat; direct = 1:1 consult thread with a bot; group = #room with @mentions. */
export const RoomKindSchema = z.enum(["lead", "direct", "group"]);
export type RoomKind = z.infer<typeof RoomKindSchema>;

export const RoomSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    kind: RoomKindSchema,
    /** The bot of a lead/direct room. */
    botName: BotNameSchema.nullable(),
    members: z.array(BotNameSchema),
    createdAt: IsoDateTimeSchema,
  })
  .superRefine((v, ctx) => {
    if (v.kind !== "group" && !v.botName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["botName"], message: `a ${v.kind} room belongs to one bot` });
    }
  });
export type Room = z.infer<typeof RoomSchema>;

export const MessageAuthorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ba") }),
  z.object({ type: z.literal("bot"), bot: BotNameSchema }),
  z.object({ type: z.literal("system") }),
]);
export type MessageAuthor = z.infer<typeof MessageAuthorSchema>;

/**
 * work = Lead chat (may start work); consult = 1:1 bot thread (UC-25);
 * discussion = group room (UC-15). Only `work` can create tasks (rule 1).
 */
export const ChatModeSchema = z.enum(["work", "consult", "discussion"]);
export type ChatMode = z.infer<typeof ChatModeSchema>;

/** Rich parts rendered under a message in the chat (§11 Chat). */
export const MessageCardSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run"), runId: IdSchema }),
  z.object({ type: z.literal("review_link"), count: z.number().int().nonnegative() }),
  z.object({ type: z.literal("job"), jobId: IdSchema }),
  z.object({
    type: z.literal("question"),
    applicationId: IdSchema,
    taskId: IdSchema,
    question: PendingQuestionSchema,
    answered: z.boolean(),
    /** Additive (W3a request): what Ba answered (the value Apply fills in); null = left blank. Set with `answered: true`. */
    answer: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal("fact_request"), jobId: IdSchema, topic: z.string(), question: z.string() }),
  z.object({
    type: z.literal("choice"),
    /** e.g. "criteria": just this run vs save to criteria (UC-21b a) */
    key: z.string().min(1),
    options: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).min(1),
    chosen: z.string().nullable(),
  }),
  z.object({ type: z.literal("handoff"), fromBot: BotNameSchema, request: z.string() }),
  z.object({ type: z.literal("delegation"), bot: BotNameSchema, task: z.string(), status: z.string() }),
  z.object({ type: z.literal("pause"), taskId: IdSchema, reason: z.string() }),
]);
export type MessageCard = z.infer<typeof MessageCardSchema>;

export const MessageSchema = z.object({
  id: IdSchema,
  roomId: IdSchema,
  author: MessageAuthorSchema,
  text: z.string(),
  mode: ChatModeSchema,
  mentions: z.array(BotNameSchema),
  runIds: z.array(IdSchema),
  uploadIds: z.array(IdSchema),
  cards: z.array(MessageCardSchema),
  createdAt: IsoDateTimeSchema,
});
export type Message = z.infer<typeof MessageSchema>;

/** `@CV @QA how…` → ["cv", "qa"] (only known bots, de-duplicated, in order). */
export function parseMentions(text: string, knownBots: readonly string[]): string[] {
  const known = new Set(knownBots.map((b) => b.toLowerCase()));
  const out: string[] = [];
  for (const m of text.matchAll(/(^|[^\w@.])@([A-Za-z][\w-]*)/g)) {
    const name = (m[2] ?? "").toLowerCase();
    if (known.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
