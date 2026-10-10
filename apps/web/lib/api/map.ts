// Shared API / SSE shapes (@bs-job-agents/shared) → the web view models. Pure, so
// Phase 3 can wire lib/api and subscribeShellEvents without touching the screens.
import type { AppEvent, BotActivity, BotView, EngineStatus, Room } from "@bs-job-agents/shared";
import type { ShellEvent } from "./live";
import type { BotLiveStatus, BotSummary, Engine, EngineUsage, RoomSummary } from "./types";

export const BOT_STATUS_BY_ACTIVITY = {
  idle: "idle",
  working: "working",
  paused: "paused",
  waiting_limit: "waiting",
  error: "error",
} as const satisfies Record<BotActivity, BotLiveStatus>;

/** The subscription each engine runs on (sidebar usage meter). */
export const ENGINE_LABELS = { claude: "Claude", codex: "ChatGPT" } as const satisfies Record<Engine, string>;

export function toBotSummary(view: Pick<BotView, "name" | "displayName" | "engine" | "trustLevel" | "role" | "activity">): BotSummary {
  return {
    name: view.name,
    displayName: view.displayName,
    engine: view.engine,
    trustLevel: view.trustLevel,
    role: view.role,
    status: BOT_STATUS_BY_ACTIVITY[view.activity],
  };
}

export function toRoomSummary(room: Pick<Room, "id" | "name">): RoomSummary {
  return { id: room.id, name: room.name };
}

export function toEngineUsage(status: Pick<EngineStatus, "engine" | "usage" | "pausedUntil">): EngineUsage {
  const windows = [status.usage?.fiveHour, status.usage?.sevenDay].filter((u): u is number => typeof u === "number");
  return {
    engine: status.engine,
    label: ENGINE_LABELS[status.engine],
    utilization: windows.length ? Math.max(...windows) : 0,
    pausedUntil: status.pausedUntil,
  };
}

/** The shell's reaction to an SSE event, or null when the shell does not show it. */
export function toShellEvent(event: AppEvent): ShellEvent | null {
  switch (event.type) {
    case "engine.paused":
      // The orchestrator always stores a reset time (now + 30 min when unknown, UC-16).
      return event.until ? { type: "engine.paused", engine: event.engine, pausedUntil: event.until } : null;
    case "engine.resumed":
      return { type: "engine.resumed", engine: event.engine };
    case "engine.usage":
      return { type: "engine.usage", engine: event.engine, utilization: toEngineUsage({ ...event, pausedUntil: null }).utilization };
    case "run.started":
      return { type: "run.started", runId: event.runId };
    case "run.finished":
      return { type: "run.finished", runId: event.runId };
    case "bot.updated":
      return { type: "bot.status", name: event.botName, status: BOT_STATUS_BY_ACTIVITY[event.activity] };
    case "bridge.status":
      return event.bridge === "chrome" ? { type: "chrome.status", connected: event.connected } : null;
    default:
      return null;
  }
}
