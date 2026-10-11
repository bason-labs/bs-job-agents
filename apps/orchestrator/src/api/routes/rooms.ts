// Rooms and their history (UC-15, UC-25): list rooms (the Lead chat and one consult thread per bot
// always exist), create a group room, page back through a room's messages with their attachments.
// Sending a message is routes/chat.ts.
import {
  API_ROUTES,
  ChatMessageSchema,
  CreateRoomRequestSchema,
  MessagesQuerySchema,
  MessagesResponseSchema,
  RoomSchema,
  RoomsResponseSchema,
} from "@bs-job-agents/shared";
import type { FastifyInstance } from "fastify";
import { createRoom, getBot, getOrCreateConsultRoom, getOrCreateLeadRoom, getRoom, listBots, listMessages, listRoomMembers, listRooms, mappers, type Db, type Room } from "../../db/index.js";
import { chatMessageView } from "../chat/messages.js";
import { requireDb, type ApiContext } from "../context.js";
import { badRequest, notFound } from "../errors.js";
import { idParam, keepValid, parseWith, respond } from "../http.js";

const toRoom = (db: Db, room: Room) => mappers.toRoom(room, listRoomMembers(db, room.id));

/** The Lead chat and a consult thread for every other bot (UC-25: a bot in the Team list opens it). */
function ensureChatRooms(ctx: ApiContext, db: Db): void {
  const now = { now: ctx.now() };
  db.transaction((tx) => {
    getOrCreateLeadRoom(tx, now);
    for (const bot of listBots(tx)) if (bot.name !== "lead") getOrCreateConsultRoom(tx, bot.name, now);
  });
}

export function roomRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const warn = (m: string) => ctx.log.warn(m);

  app.get(API_ROUTES.rooms, async () => {
    const db = requireDb(ctx);
    ensureChatRooms(ctx, db);
    return respond(RoomsResponseSchema, { rooms: keepValid(RoomSchema, listRooms(db).map((r) => toRoom(db, r)), warn) });
  });

  app.post(API_ROUTES.rooms, async (req, reply) => {
    const db = requireDb(ctx);
    const body = parseWith(CreateRoomRequestSchema, req.body);
    const unknown = body.members.filter((m) => !getBot(db, m));
    if (unknown.length > 0) throw badRequest(`members: no bot named ${unknown.join(", ")}`);
    const room = createRoom(db, { name: body.name, kind: "group", members: [...new Set(body.members)] }, { now: ctx.now() });
    void reply.code(201);
    return respond(RoomSchema, toRoom(db, room));
  });

  app.get<{ Params: { id: string } }>(API_ROUTES.roomMessages, async (req) => {
    const db = requireDb(ctx);
    const id = idParam(req.params.id, "room");
    const room = getRoom(db, id);
    if (!room) throw notFound(`room ${id} not found`);
    const q = parseWith(MessagesQuerySchema, req.query);
    const before = q.before === undefined ? undefined : idParam(q.before, "message");
    // One extra row tells whether older messages exist.
    const rows = listMessages(db, id, { ...(before !== undefined ? { beforeId: before } : {}), limit: q.limit + 1 });
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(1) : rows;
    const messages = page.map((m) => chatMessageView(db, m, room));
    return respond(MessagesResponseSchema, { messages: keepValid(ChatMessageSchema, messages, warn), hasMore });
  });
}
