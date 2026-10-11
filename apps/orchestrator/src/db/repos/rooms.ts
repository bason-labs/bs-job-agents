import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import type { Conn } from "../client.js";
import type { RoomKind } from "../enums.js";
import { messages, roomMembers, rooms, type JsonObject } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { Message, Room } from "../types.js";
import { attachUploads } from "./files.js";

export const LEAD_ROOM_NAME = "Lead";

export function createRoom(
  db: Conn,
  input: { name: string; kind: RoomKind; botName?: string | null; members?: string[] },
  opts?: ClockOpts,
): Room {
  return db.transaction((tx) => {
    const room = tx
      .insert(rooms)
      .values({ name: input.name, kind: input.kind, botName: input.botName ?? null, createdAt: nowIso(opts) })
      .returning()
      .get();
    for (const bot of input.members ?? []) addRoomMember(tx, room.id, bot);
    return room;
  });
}

export function getRoom(db: Conn, id: number): Room | undefined {
  return db.select().from(rooms).where(eq(rooms.id, id)).get();
}

export function listRooms(db: Conn, filter: { kind?: RoomKind } = {}): Room[] {
  return db
    .select()
    .from(rooms)
    .where(filter.kind ? eq(rooms.kind, filter.kind) : undefined)
    .orderBy(asc(rooms.id))
    .all();
}

/** The Lead chat is a room (§9). */
export function getOrCreateLeadRoom(db: Conn, opts?: ClockOpts): Room {
  const existing = db.select().from(rooms).where(eq(rooms.kind, "lead")).get();
  return existing ?? createRoom(db, { name: LEAD_ROOM_NAME, kind: "lead", botName: "lead", members: ["lead"] }, opts);
}

/** UC-25: one direct (consult-mode) thread per bot. */
export function getOrCreateConsultRoom(db: Conn, botName: string, opts?: ClockOpts): Room {
  const existing = db
    .select()
    .from(rooms)
    .where(and(eq(rooms.kind, "direct"), eq(rooms.botName, botName)))
    .get();
  return existing ?? createRoom(db, { name: `consult:${botName}`, kind: "direct", botName, members: [botName] }, opts);
}

export function addRoomMember(db: Conn, roomId: number, botName: string): void {
  db.insert(roomMembers).values({ roomId, botName }).onConflictDoNothing().run();
}

export function removeRoomMember(db: Conn, roomId: number, botName: string): void {
  db.delete(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.botName, botName)))
    .run();
}

/** Bot names, alphabetical. Ba is implicitly in every room. */
export function listRoomMembers(db: Conn, roomId: number): string[] {
  return db
    .select({ botName: roomMembers.botName })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId))
    .orderBy(asc(roomMembers.botName))
    .all()
    .map((r) => r.botName);
}

export interface AppendMessageInput {
  roomId: number;
  /** 'ba' or a bot name. */
  author: string;
  text: string;
  mentions?: string[];
  runRefs?: number[];
  /** E.g. `{ handoffFrom: "qa" }` (UC-25a), card payloads. */
  meta?: JsonObject | null;
  /** Uploads to link to this message (UC-24 step 2). */
  uploadIds?: number[];
}

export function appendMessage(db: Conn, input: AppendMessageInput, opts?: ClockOpts): Message {
  return db.transaction((tx) => {
    const message = tx
      .insert(messages)
      .values({
        roomId: input.roomId,
        author: input.author,
        text: input.text,
        mentions: input.mentions ?? [],
        runRefs: input.runRefs ?? [],
        meta: input.meta ?? null,
        createdAt: nowIso(opts),
      })
      .returning()
      .get();
    attachUploads(tx, input.uploadIds ?? [], message.id);
    return message;
  });
}

/** Additive (W3a request): replace a message's cards (an answered question); its text and author never change. */
export function setMessageCards(db: Conn, messageId: number, cards: unknown[]): Message | undefined {
  const current = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!current) return undefined;
  return db
    .update(messages)
    .set({ meta: { ...(current.meta ?? {}), cards: cards as never } })
    .where(eq(messages.id, messageId))
    .returning()
    .get();
}

/**
 * Messages in chronological order. With `limit`, the latest `limit` messages
 * (before `beforeId` when paging back).
 */
export function listMessages(
  db: Conn,
  roomId: number,
  opts: { afterId?: number; beforeId?: number; limit?: number } = {},
): Message[] {
  const where = and(
    eq(messages.roomId, roomId),
    opts.afterId !== undefined ? gt(messages.id, opts.afterId) : undefined,
    opts.beforeId !== undefined ? lt(messages.id, opts.beforeId) : undefined,
  );
  if (!opts.limit) return db.select().from(messages).where(where).orderBy(asc(messages.id)).all();
  return db.select().from(messages).where(where).orderBy(desc(messages.id)).limit(opts.limit).all().reverse();
}
