// View models the web app renders. Phase 3 maps orchestrator responses
// (and @bs-job-agents/shared schemas from W1a) onto these.

export type Engine = "claude" | "codex";
export type TrustLevel = 0 | 1 | 2;

/** Live bot status shown by StatusDot in the Team list. */
export type BotLiveStatus = "idle" | "working" | "waiting" | "paused" | "error" | "offline";

export interface BotSummary {
  /** Route key and DB primary key, e.g. "research". */
  name: string;
  displayName: string;
  engine: Engine;
  trustLevel: TrustLevel;
  status: BotLiveStatus;
  /** Short role line (Bots screen, tooltips). */
  role: string;
}

export interface RoomSummary {
  id: string;
  name: string;
}

export interface EngineUsage {
  engine: Engine;
  /** "Claude" / "ChatGPT" — the subscription the engine runs on. */
  label: string;
  /** 0..1 share of the current usage window. */
  utilization: number;
  /** ISO time the engine resumes when paused for its usage limit (UC-16). */
  pausedUntil: string | null;
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
