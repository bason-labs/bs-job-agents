"use client";

import type { Message, Room, Upload } from "@bs-job-agents/shared";
import { createContext, useContext } from "react";
import type { BotSummary } from "@/lib/api/types";
import type { TaskPhase } from "./model";

export interface ChatContextValue {
  room: Room;
  bots: readonly BotSummary[];
  /** All messages on screen (question cards look for the newest one of their task). */
  messages: readonly Message[];
  /** What the live events said about a task since the page opened. */
  taskPhase: (taskId: string) => TaskPhase | undefined;
  /** The bot a task belongs to, when an event named it. */
  taskBot: (taskId: string) => string | undefined;
  /** Uploads made from this tab (names and sizes for the chips). */
  uploads: Readonly<Record<string, Upload>>;
}

export const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used inside <ChatScreen>");
  return ctx;
}

export function botDisplay(bots: readonly BotSummary[], name: string): string {
  return bots.find((b) => b.name === name)?.displayName ?? name.charAt(0).toUpperCase() + name.slice(1);
}
