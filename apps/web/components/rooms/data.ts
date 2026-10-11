// Data access for group rooms (UC-15).
//
// Screens import `roomsData` from here and nothing else, so wiring the real API is a one-line
// change: replace the fixture implementation below with an adapter over lib/api (W3b's typed
// client and SSE subscription). Shapes are the shared schemas.
//   GET  /rooms                → RoomsResponseSchema (find the room by id)
//   GET  /rooms/:id/messages?before=&limit= → MessagesResponseSchema { messages, hasMore }
//   POST /chat/messages        → body ChatSendRequestSchema { roomId, text, uploadIds } → { message }
//   SSE  message.created       → bot replies (discussion mode), filtered by roomId
//   GET  /bots                 → display names and roles for the member list
import { ChatSendRequestSchema, type Message, type MessagesResponseSchema, type Room } from "@bs-job-agents/shared";
import type { z } from "zod";
import { BOT_VIEWS } from "@/components/bots/fixtures";
import { roomMentions, type RoomMember } from "./mentions";

export type MessagesPage = z.infer<typeof MessagesResponseSchema>;

export interface RoomBot extends RoomMember {
  role: string;
}

export interface RoomsData {
  getRoom(id: string): Promise<Room | null>;
  /** Display names and roles of the bots (members and @mention suggestions). */
  bots(): Promise<RoomBot[]>;
  /** A page of history, oldest first; `before` pages back from a message id. */
  messages(roomId: string, query?: { before?: string; limit?: number }): Promise<MessagesPage>;
  /** Posts Ba's message; mentioned bots answer later through `subscribe`. */
  send(roomId: string, text: string): Promise<Message>;
  /** New messages in the room (SSE message.created). Returns an unsubscribe function. */
  subscribe(roomId: string, onMessage: (message: Message) => void): () => void;
}

/** The prototype's room replies, per bot (discussion mode: answers only, never actions). */
const CANNED_REPLIES: Record<string, string> = {
  cv: "From my side: I can draft two variants and let QA pick. I only use facts already in your master data.",
  qa: "I would score this on JD keyword coverage first; tone second. Happy to run a dry score.",
  research: "I can pull 3 example JDs for that role so we compare against real requirements.",
  apply: "I don't act in rooms (discussion mode). Approve a review card and I'll handle the form.",
  lead: 'Want me to turn this into a task? Say "@Lead make it a task".',
};

const ROOM: Room = {
  id: "cv-brainstorm",
  name: "cv-brainstorm",
  kind: "group",
  botName: null,
  members: ["lead", "research", "cv", "qa", "apply"],
  createdAt: "2026-10-10T20:00:00+07:00",
};

const msg = (id: string, author: Message["author"], text: string, at: string, mentions: string[] = []): Message => ({
  id,
  roomId: ROOM.id,
  author,
  text,
  mode: "discussion",
  mentions,
  runIds: [],
  uploadIds: [],
  cards: [],
  createdAt: at,
});

const SEED: Message[] = [
  msg("msg_r1", { type: "ba" }, "@CV @QA how should I present the AI lab work for AI-focused roles?", "2026-10-10T20:01:00+07:00", ["cv", "qa"]),
  msg(
    "msg_r2",
    { type: "bot", bot: "cv" },
    'Lead with the CV-screening project as the first Gradion bullet: "Built AI-assisted CV screening (n8n + Genkit) that learns from reviewer feedback". Keep it to one line, link to fact grad-3.',
    "2026-10-10T20:01:20+07:00",
  ),
  msg(
    "msg_r3",
    { type: "bot", bot: "qa" },
    'Agree. For ATS, include the literal keywords "LLM", "prompt engineering" only if master data supports them — right now it supports "AI workflows" and "prompts", not "LLM fine-tuning".',
    "2026-10-10T20:01:40+07:00",
  ),
];

/** In-memory stand-in: mentioned bots answer with the prototype's replies after a short delay. */
export function createFixtureRoomsData(opts: { replyDelayMs?: number; now?: () => Date } = {}): RoomsData {
  const delay = opts.replyDelayMs ?? 900;
  const now = opts.now ?? (() => new Date());
  const rooms = new Map([[ROOM.id, structuredClone(ROOM)]]);
  const log = new Map([[ROOM.id, structuredClone(SEED)]]);
  const listeners = new Map<string, Set<(m: Message) => void>>();
  let seq = SEED.length;

  const bots: RoomBot[] = BOT_VIEWS.map((b) => ({ name: b.name, displayName: b.displayName, role: b.role }));
  const emit = (m: Message) => {
    log.get(m.roomId)?.push(m);
    listeners.get(m.roomId)?.forEach((l) => l(structuredClone(m)));
  };

  return {
    async getRoom(id) {
      const r = rooms.get(id);
      return r ? structuredClone(r) : null;
    },
    async bots() {
      return bots.map((b) => ({ ...b }));
    },
    async messages(roomId, query = {}) {
      const all = log.get(roomId) ?? [];
      const end = query.before ? all.findIndex((m) => m.id === query.before) : all.length;
      const upTo = end < 0 ? all.length : end;
      const limit = query.limit ?? 50;
      const start = Math.max(0, upTo - limit);
      return { messages: structuredClone(all.slice(start, upTo)), hasMore: start > 0 };
    },
    async send(roomId, text) {
      ChatSendRequestSchema.parse({ roomId, text, uploadIds: [] });
      const room = rooms.get(roomId);
      if (!room) throw new Error(`room ${roomId} not found`);
      const members = bots.filter((b) => room.members.includes(b.name));
      const mentions = roomMentions(text, members);
      const mine = msg(`msg_r${++seq}`, { type: "ba" }, text, now().toISOString(), mentions);
      mine.roomId = roomId;
      log.get(roomId)?.push(mine);
      mentions.forEach((bot, i) => {
        setTimeout(
          () => {
            const reply = msg(`msg_r${++seq}`, { type: "bot", bot }, CANNED_REPLIES[bot] ?? "Noted.", now().toISOString());
            reply.roomId = roomId;
            emit(reply);
          },
          delay + i * Math.round(delay * 0.8),
        );
      });
      return structuredClone(mine);
    },
    subscribe(roomId, onMessage) {
      const set = listeners.get(roomId) ?? new Set();
      set.add(onMessage);
      listeners.set(roomId, set);
      return () => set.delete(onMessage);
    },
  };
}

export const roomsData: RoomsData = createFixtureRoomsData();
