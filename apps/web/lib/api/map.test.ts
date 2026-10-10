import type { AppEvent, BotView, EngineStatus, Room } from "@bs-job-agents/shared";
import { sampleEvents } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { MOCK_SHELL_DATA } from "@/lib/mock/shell";
import { applyShellEvent } from "./live";
import { BOT_STATUS_BY_ACTIVITY, ENGINE_LABELS, toBotSummary, toEngineUsage, toRoomSummary, toShellEvent } from "./map";

const event = <T extends AppEvent["type"]>(type: T) => sampleEvents.find((e) => e.type === type) as Extract<AppEvent, { type: T }>;

const RESEARCH_VIEW: BotView = {
  name: "research",
  displayName: "Research",
  engine: "codex",
  model: null,
  trustLevel: 2,
  promptVersion: 1,
  enabled: true,
  role: "Finds jobs, scores fit, profiles companies (read-only browser).",
  activity: "waiting_limit",
  trackRecord: null,
  promotionSuggested: false,
  promoteAllowed: true,
  memory: [],
  residualRisk: "Site allowlist is prompt-only on Codex",
};

describe("shared → view models (Phase 3 wiring)", () => {
  it("maps a shared BotView to the sidebar BotSummary", () => {
    expect(toBotSummary(RESEARCH_VIEW)).toEqual({
      name: "research",
      displayName: "Research",
      engine: "codex",
      trustLevel: 2,
      role: "Finds jobs, scores fit, profiles companies (read-only browser).",
      status: "waiting",
    });
    expect(BOT_STATUS_BY_ACTIVITY).toEqual({ idle: "idle", working: "working", paused: "paused", waiting_limit: "waiting", error: "error" });
  });

  it("maps a shared EngineStatus to the usage meter (highest window, subscription label)", () => {
    const status: EngineStatus = {
      engine: "claude",
      pausedUntil: null,
      reason: null,
      usage: { fiveHour: 0.42, sevenDay: 0.18, resetsAt: null },
      activeSessions: 1,
      maxSessions: 2,
    };
    expect(toEngineUsage(status)).toEqual({ engine: "claude", label: "Claude", utilization: 0.42, pausedUntil: null });
    const paused: EngineStatus = { ...status, engine: "codex", usage: null, pausedUntil: "2026-10-10T14:05:00+07:00", reason: "usage_limit" };
    expect(toEngineUsage(paused)).toEqual({
      engine: "codex",
      label: "ChatGPT",
      utilization: 0,
      pausedUntil: "2026-10-10T14:05:00+07:00",
    });
    expect(ENGINE_LABELS).toEqual({ claude: "Claude", codex: "ChatGPT" });
  });

  it("maps a shared Room to a sidebar room", () => {
    const room: Room = { id: "7", name: "cv-brainstorm", kind: "group", botName: null, members: ["cv"], createdAt: "2026-10-10T08:00:00Z" };
    expect(toRoomSummary(room)).toEqual({
      id: "7",
      name: "cv-brainstorm",
    });
  });
});

describe("toShellEvent: SSE AppEvent → shell reducer event", () => {
  it.each([
    ["engine.paused", { type: "engine.paused", engine: "claude", pausedUntil: "2026-10-10T14:05:00+07:00" }],
    ["engine.resumed", { type: "engine.resumed", engine: "claude" }],
    ["engine.usage", { type: "engine.usage", engine: "claude", utilization: 0.42 }],
    ["run.started", { type: "run.started", runId: "run_13" }],
    ["run.finished", { type: "run.finished", runId: "run_13" }],
    ["bot.updated", { type: "bot.status", name: "apply", status: "idle" }],
    ["bridge.status", { type: "chrome.status", connected: false }],
  ] as const)("%s", (type, expected) => {
    expect(toShellEvent(event(type))).toEqual(expected);
  });

  it("ignores events the shell does not show, a Figma bridge, and a pause without a reset time", () => {
    expect(toShellEvent(event("task.progress"))).toBeNull();
    expect(toShellEvent(event("review.ready"))).toBeNull();
    expect(toShellEvent({ ...event("bridge.status"), bridge: "figma" })).toBeNull();
    expect(toShellEvent({ ...event("engine.paused"), until: null })).toBeNull();
  });

  it("feeds the existing reducer", () => {
    const next = applyShellEvent(MOCK_SHELL_DATA, toShellEvent(event("engine.paused"))!);
    expect(next.usage.find((u) => u.engine === "claude")?.pausedUntil).toBe("2026-10-10T14:05:00+07:00");
  });
});
