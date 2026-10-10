// View models the web app renders, derived from @bs-job-agents/shared where a shared
// type exists. Phase 3 maps orchestrator responses onto these with lib/api/map.ts.
import type { BotView, EngineStatus, Engine as SharedEngine, Room, TrustLevel as SharedTrustLevel } from "@bs-job-agents/shared";

export type Engine = SharedEngine;
export type TrustLevel = SharedTrustLevel;

/**
 * Live bot status shown by StatusDot in the Team list. The shared BotActivity maps
 * onto it (waiting_limit → waiting, see BOT_STATUS_BY_ACTIVITY); `offline` is the
 * UI's own state for a bot whose engine or bridge is unreachable.
 */
export type BotLiveStatus = "idle" | "working" | "waiting" | "paused" | "error" | "offline";

export interface BotSummary extends Pick<BotView, "name" | "displayName" | "engine" | "trustLevel" | "role"> {
  status: BotLiveStatus;
}

export type RoomSummary = Pick<Room, "id" | "name">;

export interface EngineUsage {
  engine: Engine;
  /** "Claude" / "ChatGPT" — the subscription the engine runs on. */
  label: string;
  /** 0..1 share of the current usage window (the higher of the 5-hour and 7-day windows). */
  utilization: number;
  /** ISO time the engine resumes when paused for its usage limit (UC-16). */
  pausedUntil: EngineStatus["pausedUntil"];
}

export interface ShellData {
  bots: BotSummary[];
  rooms: RoomSummary[];
  usage: EngineUsage[];
  /** Cards waiting in the Review queue (sidebar badge). */
  reviewCount: number;
  /** Set while a workflow run is active (pulsing dot next to Flows). */
  activeRunId: string | null;
  chromeConnected: boolean;
}
