// Chat plumbing shared by the chat route, the ConversationSink and the MCP server's message_user:
// post a message with its message.created event (inside the caller's transaction), and build the
// untrusted history a conversation task sees (§10.2 rule 4: other bots wrote part of it).
import type { ChatMessage, MessageCard } from "@bs-job-agents/shared";
import { eq, like } from "drizzle-orm";
import {
  schema,
  appendAppEvent,
  appendMessage,
  getUpload,
  listMessages,
  listUploadsForMessage,
  mappers,
  type Conn,
  type JsonObject,
  type Message,
  type Room,
} from "../../db/index.js";

/** Messages a conversation task sees before Ba's new one. */
export const HISTORY_MESSAGES = 20;
/** Characters kept per history message (the rest is cut with "…"). */
export const HISTORY_TEXT_MAX = 2_000;
/** A bot reply or a message_user text longer than this is cut. */
export const REPLY_TEXT_MAX = 8_000;

export const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export interface PostMessageInput {
  room: Room;
  /** "ba", "system" or a bot name. */
  author: string;
  text: string;
  mentions?: string[];
  runRefs?: number[];
  cards?: MessageCard[];
  uploadIds?: number[];
  /** Extra meta keys (e.g. handoffFrom). */
  meta?: JsonObject;
}

/** Append a message and its message.created event in `conn`'s transaction; the caller flushes the bus. */
export function postMessage(conn: Conn, input: PostMessageInput, now: Date): Message {
  const cards = input.cards ?? [];
  const meta: JsonObject | null = cards.length > 0 || input.meta ? { ...(input.meta ?? {}), ...(cards.length > 0 ? { cards: cards as unknown as JsonObject[] } : {}) } : null;
  const message = appendMessage(
    conn,
    {
      roomId: input.room.id,
      author: input.author,
      text: input.text,
      mentions: input.mentions ?? [],
      runRefs: input.runRefs ?? [],
      meta,
      uploadIds: input.uploadIds ?? [],
    },
    { now },
  );
  // F8: the event carries the attachments too, so a chip shows the file's name and type (never just "Attachment").
  const view = (input.uploadIds ?? []).length > 0 ? chatMessageView(conn, message, input.room) : mappers.toMessage(message, input.room.kind, []);
  appendAppEvent(conn, { type: "message.created", roomId: String(input.room.id), message: view }, { now });
  return message;
}

const authorLabel = (author: string): string => (author === "ba" ? "Ba" : author);

/** One line per attachment: what Ba attached (the names are untrusted, so they go in history). */
export function attachmentNotes(conn: Conn, uploadIds: readonly number[]): string[] {
  return uploadIds.map((id) => {
    const u = getUpload(conn, id);
    return u ? `Ba attached upload ${u.id}: ${clip(u.filename, 200)} (${u.mime}, ${u.size} bytes)` : `Ba attached upload ${id}`;
  });
}

/**
 * The room's last messages before `beforeId`, oldest first, as `{ author, text }`, plus a line per
 * attachment of the new message. The prompt puts it in an UNTRUSTED_CONTENT block.
 */
export function conversationHistory(conn: Conn, roomId: number, beforeId: number, uploadIds: readonly number[] = []): { author: string; text: string }[] {
  const rows = listMessages(conn, roomId, { beforeId, limit: HISTORY_MESSAGES });
  const history = rows.map((m) => ({ author: authorLabel(m.author), text: clip(m.text, HISTORY_TEXT_MAX) }));
  for (const note of attachmentNotes(conn, uploadIds)) history.push({ author: "system", text: note });
  return history;
}

/** A message with its attachments, as the REST API returns it (UC-24 chips open in the viewer). */
export function chatMessageView(conn: Conn, message: Message, room: Pick<Room, "kind">): ChatMessage {
  const uploads = listUploadsForMessage(conn, message.id);
  return {
    ...mappers.toMessage(message, room.kind, uploads.map((u) => u.id)),
    attachments: uploads.map((u) => ({
      id: String(u.id),
      filename: u.filename,
      mime: u.mime,
      size: u.size,
      file: { id: `upload-${u.id}`, kind: "upload" as const, filename: u.filename, mime: u.mime },
    })),
  };
}

export function cardsOf(message: Message): MessageCard[] {
  return (message.meta?.cards as MessageCard[] | undefined) ?? [];
}

/** Replace a message's cards (a chosen chip, an answered question); its text and author never change. */
export function updateMessageCards(conn: Conn, message: Message, cards: MessageCard[]): void {
  conn
    .update(schema.messages)
    .set({ meta: { ...(message.meta ?? {}), cards: cards as unknown as JsonObject[] } })
    .where(eq(schema.messages.id, message.id))
    .run();
}

export function getMessage(conn: Conn, id: number): Message | undefined {
  return conn.select().from(schema.messages).where(eq(schema.messages.id, id)).get();
}

/** Messages of every room whose cards include a question card for `taskId` (UC-12). */
export function messagesWithQuestionCards(conn: Conn, taskId: number): Message[] {
  return conn
    .select()
    .from(schema.messages)
    .where(like(schema.messages.meta, `%"taskId":"${taskId}"%`))
    .all()
    .filter((m) => cardsOf(m).some((c) => c.type === "question" && c.taskId === String(taskId)));
}
