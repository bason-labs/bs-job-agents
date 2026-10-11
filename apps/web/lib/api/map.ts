// Shared API / SSE shapes (@bs-job-agents/shared) → the web view models. Pure, so
// Phase 3 can wire lib/api and subscribeShellEvents without touching the screens.
import { PHASE1_BOTS, type AppEvent, type BotActivity, type BotView, type EngineStatus, type Room, type Run } from "@bs-job-agents/shared";
import type { ShellEvent } from "./live";
import type { BotLiveStatus, BotSummary, Engine, EngineUsage, RoomSummary, ShellData } from "./types";

export const BOT_STATUS_BY_ACTIVITY = {
  idle: "idle",
  working: "working",
  paused: "paused",
  waiting_limit: "waiting",
  error: "error",
} as const satisfies Record<BotActivity, BotLiveStatus>;

/** The subscription each engine runs on (sidebar usage meter). */
export const ENGINE_LABELS = { claude: "Claude", codex: "ChatGPT" } as const satisfies Record<Engine, string>;

/** The CLI a bot runs on (bot chips, composer, node drawer), as in the prototype. */
export const ENGINE_NAMES = { claude: "Claude", codex: "Codex" } as const satisfies Record<Engine, string>;

/** Prototype order: Lead, Research, CV, QA, Apply; bots added later follow by name. */
export function sortBots<T extends { name: string }>(bots: readonly T[]): T[] {
  const rank = (name: string) => {
    const i = (PHASE1_BOTS as readonly string[]).indexOf(name);
    return i === -1 ? PHASE1_BOTS.length : i;
  };
  return [...bots].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

const ACTIVE_RUN_STATUSES: readonly Run["status"][] = ["running", "waiting", "paused"];

/** The newest run that has not finished (pulsing dot next to Flows). */
export function activeRunId(runs: readonly Pick<Run, "id" | "status" | "createdAt">[]): string | null {
  const active = runs.filter((r) => ACTIVE_RUN_STATUSES.includes(r.status));
  active.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return active[0]?.id ?? null;
}

export interface ShellSources {
  bots: readonly BotView[];
  rooms: readonly Room[];
  engines: readonly EngineStatus[];
  reviewCount: number;
  runs: readonly Pick<Run, "id" | "status" | "createdAt">[];
  chromeConnected: boolean;
}

/**
 * The sidebar while the orchestrator is unreachable: the five Phase 1 bots as in the spec (§5.2),
 * shown offline, and nothing else. Never sample data in live mode.
 */
export function offlineShellData(): ShellData {
  const bot = (name: string, displayName: string, engine: Engine, trustLevel: 0 | 1 | 2, role: string): BotSummary => ({
    name,
    displayName,
    engine,
    trustLevel,
    role,
    status: "offline",
  });
  return {
    bots: [
      bot("lead", "Lead", "claude", 1, "Receives every request; only divides work."),
      bot("research", "Research", "codex", 2, "Finds jobs, scores fit, profiles companies (read-only browser)."),
      bot("cv", "CV", "claude", 2, "Tailors CV in Figma from master facts; never invents."),
      bot("qa", "QA", "codex", 2, "Scores CV vs JD + company; hard-fails invented facts."),
      bot("apply", "Apply", "claude", 1, "Fills & submits forms in your Chrome after your approval."),
    ],
    rooms: [],
    usage: (["claude", "codex"] as const).map((engine) => ({ engine, label: ENGINE_LABELS[engine], utilization: 0, pausedUntil: null })),
    reviewCount: 0,
    activeRunId: null,
    chromeConnected: true,
  };
}

/** GET /bots, /rooms, /engines, /review and /runs → the sidebar's ShellData. */
export function toShellData(src: ShellSources): ShellData {
  return {
    bots: sortBots(src.bots).map(toBotSummary),
    // Lead and direct (consult) rooms open from the Team list; the Rooms list shows group rooms.
    rooms: src.rooms.filter((r) => r.kind === "group").map(toRoomSummary),
    usage: src.engines.map(toEngineUsage),
    reviewCount: src.reviewCount,
    activeRunId: activeRunId(src.runs),
    chromeConnected: src.chromeConnected,
  };
}

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
