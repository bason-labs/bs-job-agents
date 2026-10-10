// Live-update seam for the shell (spec §11 "Live updates": SSE events).
// Phase 3 (W3a/W3b): implement `subscribeShellEvents` with an EventSource on
// the orchestrator and map its `engine.paused/resumed`, `review.ready`,
// `run.*` and task events onto ShellEvent. The reducer below stays as is.
import type { BotLiveStatus, Engine, ShellData } from "./types";

export type ShellEvent =
  | { type: "bot.status"; name: string; status: BotLiveStatus }
  | { type: "engine.paused"; engine: Engine; pausedUntil: string }
  | { type: "engine.resumed"; engine: Engine }
  | { type: "engine.usage"; engine: Engine; utilization: number }
  | { type: "review.count"; reviewCount: number }
  | { type: "run.started"; runId: string }
  | { type: "run.finished"; runId: string }
  | { type: "chrome.status"; connected: boolean };

/** Pure: returns new ShellData with the event applied. */
export function applyShellEvent(data: ShellData, event: ShellEvent): ShellData {
  switch (event.type) {
    case "bot.status":
      return { ...data, bots: data.bots.map((b) => (b.name === event.name ? { ...b, status: event.status } : b)) };
    case "engine.paused":
      return { ...data, usage: data.usage.map((u) => (u.engine === event.engine ? { ...u, pausedUntil: event.pausedUntil } : u)) };
    case "engine.resumed":
      return { ...data, usage: data.usage.map((u) => (u.engine === event.engine ? { ...u, pausedUntil: null } : u)) };
    case "engine.usage":
      return { ...data, usage: data.usage.map((u) => (u.engine === event.engine ? { ...u, utilization: event.utilization } : u)) };
    case "review.count":
      return { ...data, reviewCount: event.reviewCount };
    case "run.started":
      return { ...data, activeRunId: event.runId };
    case "run.finished":
      return data.activeRunId === event.runId ? { ...data, activeRunId: null } : data;
    case "chrome.status":
      return { ...data, chromeConnected: event.connected };
  }
}

/** Subscribes to shell events; returns an unsubscribe function. No-op until Phase 3. */
export function subscribeShellEvents(_onEvent: (event: ShellEvent) => void): () => void {
  return () => {};
}
