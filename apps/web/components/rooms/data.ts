// Data access for rooms (UC-15, UC-25): an adapter over lib/api (the orchestrator in live mode, the
// mock backend otherwise). Shapes are the shared schemas:
//   GET  /rooms                → RoomsResponseSchema: the Lead chat, one direct (consult) room per bot,
//                                and the group rooms (find a room by id; unknown → null)
//   POST /rooms                → 201 CreateRoomRequestSchema { name, members } → Room (400 when invalid)
//   GET  /rooms/:id/messages?before=&limit= → MessagesResponseSchema { messages, hasMore }
//   POST /chat/messages        → body ChatSendRequestSchema { roomId, text, uploadIds } → { message, taskIds }
//   SSE  message.created       → bot replies (discussion mode) and system notes, filtered by roomId
//   SSE  task.finished         → a mentioned bot that stopped without answering (failed, cancelled)
//   GET  /bots                 → display names and roles for the member list
"use client";

import { API_ROUTES, RoomSchema, type Message, type MessagesResponseSchema, type Room } from "@bs-job-agents/shared";
import { useMemo } from "react";
import type { z } from "zod";
import type { WebApi } from "@/lib/api/contract";
import { useApi } from "@/lib/api/react";
import type { RoomMember } from "./mentions";

export type MessagesPage = z.infer<typeof MessagesResponseSchema>;

export interface RoomBot extends RoomMember {
  role: string;
}

export interface RoomListeners {
  /** A new message in the room (Ba's from another tab, a bot's reply, a system note). */
  onMessage: (message: Message) => void;
  /** A bot's task ended without a reply (failed, interrupted): stop showing it as answering. */
  onBotStopped?: (bot: string) => void;
}

export interface RoomsData {
  /** Every room (Lead, direct consult threads, group rooms). */
  rooms(): Promise<Room[]>;
  getRoom(id: string): Promise<Room | null>;
  /** UC-15: a new group room. */
  createRoom(name: string, members: string[]): Promise<Room>;
  /** Display names and roles of the bots (members and @mention suggestions). */
  bots(): Promise<RoomBot[]>;
  /** A page of history, oldest first; `before` pages back from a message id. */
  messages(roomId: string, query?: { before?: string; limit?: number }): Promise<MessagesPage>;
  /** Posts Ba's message; mentioned bots answer later through `subscribe`. */
  send(roomId: string, text: string): Promise<Message>;
  /** Live updates for one room (SSE). Returns an unsubscribe function. */
  subscribe(roomId: string, listeners: RoomListeners): () => void;
}

export function createRoomsData(api: Pick<WebApi, "request" | "listRooms" | "listBots" | "listMessages" | "sendMessage" | "events">): RoomsData {
  return {
    rooms() {
      return api.listRooms();
    },
    async getRoom(id) {
      return (await api.listRooms()).find((r) => r.id === id) ?? null;
    },
    createRoom(name, members) {
      return api.request("POST", API_ROUTES.rooms, { body: { name, members }, schema: RoomSchema });
    },
    async bots() {
      return (await api.listBots()).map((b) => ({ name: b.name, displayName: b.displayName, role: b.role }));
    },
    messages(roomId, query = {}) {
      return api.listMessages(roomId, query);
    },
    send(roomId, text) {
      return api.sendMessage({ roomId, text });
    },
    subscribe(roomId, { onMessage, onBotStopped }) {
      return api.events.subscribe((e) => {
        if (e.type === "message.created" && e.roomId === roomId) onMessage(e.message);
        else if (e.type === "task.finished" && e.status !== "done" && e.runId === null) onBotStopped?.(e.botName);
      });
    },
  };
}

export function useRoomsData(): RoomsData {
  const api = useApi();
  return useMemo(() => createRoomsData(api), [api]);
}

/** Who can be @mentioned in a group room: its members, and Lead, who always answers (“@Lead make it a task”). */
export function mentionableBots(room: Pick<Room, "members">, bots: readonly RoomBot[]): RoomBot[] {
  return bots.filter((b) => b.name === "lead" || room.members.includes(b.name));
}
