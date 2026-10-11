// Chat (spec §11; UC-01, UC-14, UC-15, UC-24, UC-25; PM2 S20). Ba's message is stored first (with
// its uploads linked, UC-24 step 2), then the conversation tasks it asks for are queued through the
// engine's validated seam (enqueueConversation):
// - the Lead chat → lead.chat (rule 1: every request goes through Lead);
// - a consult thread → <bot>.consult (UC-25: answers only; work is handed to Lead by the sink);
// - a group room → one discussion reply per @mentioned member (UC-15), and lead.chat for @Lead
//   ("@Lead turn this into a task"); a message without a mention goes to no bot.
// The history each task sees is untrusted (other bots wrote it, §10.2 rule 4). Replies arrive as
// message.created events (ChatSink).
import {
  API_ROUTES,
  ChatSendRequestSchema,
  ChatSendResultSchema,
  ChoiceRequestSchema,
  ROOM_MENTION_CAP,
  parseMentions,
  type ChatSendResult,
  type ConversationInput,
  type LeadChatInput,
} from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { getRoom, getUpload, listRoomMembers, type Room } from "../../db/index.js";
import { EngineError, type Engine } from "../../engine/index.js";
import { cardsOf, chatMessageView, conversationHistory, getMessage, postMessage, updateMessageCards } from "../chat/messages.js";
import { botLabel } from "../chat/sink.js";
import { requireEngine, type ApiContext } from "../context.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { idParam, parseWith, respond } from "../http.js";

type Target = { bot: string; kind: "chat" | "consult" | "discussion" };

/** Who answers a message in this room. */
function targetsFor(engine: Engine, room: Room, text: string): { targets: Target[]; notes: string[] } {
  if (room.kind === "lead") return { targets: [{ bot: "lead", kind: "chat" }], notes: [] };
  if (room.kind === "direct") return { targets: room.botName ? [{ bot: room.botName, kind: "consult" }] : [], notes: [] };
  const members = listRoomMembers(engine.db, room.id);
  const known = engine.deps.bots.list().map((b) => b.name);
  const mentioned = parseMentions(text, known);
  const notes: string[] = [];
  const answering = mentioned.filter((b) => b === "lead" || members.includes(b));
  const outsiders = mentioned.filter((b) => !answering.includes(b));
  if (outsiders.length > 0) notes.push(`${outsiders.map((b) => `@${botLabel(b)}`).join(", ")} ${outsiders.length === 1 ? "is" : "are"} not in this room.`);
  const capped = answering.slice(0, ROOM_MENTION_CAP);
  if (answering.length > capped.length) notes.push(`Only the first ${ROOM_MENTION_CAP} mentioned bots answer one message.`);
  return { targets: capped.map((bot) => ({ bot, kind: bot === "lead" ? "chat" : "discussion" })), notes };
}

/** Store Ba's message, then queue the replies. Used by POST /chat/messages and the choice chips. */
export function sendChatMessage(ctx: ApiContext, engine: Engine, room: Room, text: string, uploadIds: number[]): ChatSendResult {
  const db = engine.db;
  const now = ctx.now();
  const { targets, notes } = targetsFor(engine, room, text);
  const message = db.transaction((tx) => {
    for (const id of uploadIds) {
      const upload = getUpload(tx, id);
      if (!upload) throw badRequest(`upload ${id} not found; attach the file again`);
      if (upload.messageId !== null) throw conflict(`upload ${id} is already attached to another message`);
    }
    const mentions = room.kind === "group" ? targets.map((t) => t.bot) : [];
    const stored = postMessage(tx, { room, author: "ba", text, mentions, uploadIds }, now);
    for (const note of notes) postMessage(tx, { room, author: "system", text: note }, now);
    return stored;
  });
  ctx.events?.flush();

  const history = conversationHistory(db, room.id, message.id, uploadIds);
  const base: ConversationInput = { roomId: String(room.id), messageId: String(message.id), text, history, uploadIds: uploadIds.map(String) };
  const taskIds: string[] = [];
  for (const target of targets) {
    try {
      const input: ConversationInput | LeadChatInput = target.kind === "chat" ? { ...base, handoff: null } : base;
      taskIds.push(String(engine.enqueueConversation({ bot: target.bot, kind: target.kind, input }).taskId));
    } catch (err) {
      // e.g. the bot is disabled on the Bots screen: Ba's message stays, with a note why no one answers.
      const why = err instanceof EngineError ? err.message : "it could not be queued";
      db.transaction((tx) => postMessage(tx, { room, author: "system", text: `@${botLabel(target.bot)} will not answer: ${why}.` }, ctx.now()));
      ctx.events?.flush();
      if (!(err instanceof EngineError)) ctx.log.warn(`chat: queueing ${target.bot}.${target.kind} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { message: chatMessageView(db, message, room), taskIds };
}

export function chatRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.post(API_ROUTES.chatSend, async (req, reply) => {
    const engine = requireEngine(ctx);
    const body = parseWith(ChatSendRequestSchema, req.body);
    const roomId = idParam(body.roomId, "room");
    const room = getRoom(engine.db, roomId);
    if (!room) throw notFound(`room ${roomId} not found`);
    const uploadIds = [...new Set(body.uploadIds.map((u) => idParam(u, "upload")))];
    const result = sendChatMessage(ctx, engine, room, body.text, uploadIds);
    void reply.code(201);
    return respond(ChatSendResultSchema, result);
  });

  // A suggestion chip on Lead's card (UC-01 a, UC-21b a): the choice is kept on the card and its
  // label is sent as Ba's answer in the same room.
  app.post(API_ROUTES.chatChoices, async (req, reply) => {
    const engine = requireEngine(ctx);
    const body = parseWith(ChoiceRequestSchema, req.body);
    const messageId = idParam(body.messageId, "message");
    const message = getMessage(engine.db, messageId);
    if (!message) throw notFound(`message ${messageId} not found`);
    const cards = cardsOf(message);
    const index = cards.findIndex((c) => c.type === "choice" && c.key === body.key);
    const card = cards[index];
    if (!card || card.type !== "choice") throw notFound(`message ${messageId} has no ${body.key} choice`);
    if (card.chosen !== null) throw conflict("this choice was already made");
    const option = card.options.find((o) => o.id === body.optionId);
    if (!option) throw badRequest(`option ${body.optionId} is not one of this card's choices`);
    const room = getRoom(engine.db, message.roomId);
    if (!room) throw notFound(`room ${message.roomId} not found`);
    const figma = /^figma-change:([1-9]\d{0,15})$/.exec(body.key);
    if (figma && option.id === "was_me") {
      // PM2 S8 "That was me — retry": an answer to the engine, not a request for Lead. The engine
      // undoes the task's demotion, settles the card and re-runs the failed step.
      const { retried } = engine.protectedChangeWasBa(Number(figma[1]));
      const bot = engine.deps.bots.get("cv")?.displayName ?? "CV";
      const stored = engine.db.transaction((tx) => {
        const ba = postMessage(tx, { room, author: "ba", text: option.label }, ctx.now());
        const note = retried ? `Noted: the change was yours, so it isn't held against ${bot}. ${bot} is working on it again.` : `Noted: the change was yours, so it isn't held against ${bot}.`;
        postMessage(tx, { room, author: "lead", text: note }, ctx.now());
        return ba;
      });
      ctx.events?.flush();
      void reply.code(201);
      return respond(ChatSendResultSchema, { message: chatMessageView(engine.db, stored, room), taskIds: [] });
    }
    engine.db.transaction((tx) => updateMessageCards(tx, message, cards.map((c, i) => (i === index ? { ...card, chosen: option.id } : c))));
    void reply.code(201);
    return respond(ChatSendResultSchema, sendChatMessage(ctx, engine, room, option.label, []));
  });
}
