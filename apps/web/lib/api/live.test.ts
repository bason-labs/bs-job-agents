import { describe, expect, it } from "vitest";
import { MOCK_SHELL_DATA } from "@/lib/mock/shell";
import { applyShellEvent } from "./live";

const base = MOCK_SHELL_DATA;

describe("applyShellEvent", () => {
  it("updates a bot's live status", () => {
    const next = applyShellEvent(base, { type: "bot.status", name: "qa", status: "working" });
    expect(next.bots.find((b) => b.name === "qa")?.status).toBe("working");
    expect(base.bots.find((b) => b.name === "qa")?.status).toBe("idle"); // immutable
  });

  it("pauses and resumes an engine (UC-16)", () => {
    const paused = applyShellEvent(base, { type: "engine.paused", engine: "claude", pausedUntil: "2026-10-10T10:00:00Z" });
    expect(paused.usage.find((u) => u.engine === "claude")?.pausedUntil).toBe("2026-10-10T10:00:00Z");
    const resumed = applyShellEvent(paused, { type: "engine.resumed", engine: "claude" });
    expect(resumed.usage.find((u) => u.engine === "claude")?.pausedUntil).toBeNull();
  });

  it("tracks usage, review count, runs and Chrome", () => {
    let d = applyShellEvent(base, { type: "engine.usage", engine: "codex", utilization: 0.5 });
    expect(d.usage.find((u) => u.engine === "codex")?.utilization).toBe(0.5);
    d = applyShellEvent(d, { type: "review.count", reviewCount: 4 });
    expect(d.reviewCount).toBe(4);
    d = applyShellEvent(d, { type: "run.finished", runId: "12" });
    expect(d.activeRunId).toBeNull();
    d = applyShellEvent(d, { type: "run.started", runId: "13" });
    expect(d.activeRunId).toBe("13");
    d = applyShellEvent(d, { type: "chrome.status", connected: false });
    expect(d.chromeConnected).toBe(false);
  });

  it("ignores a run.finished for a different run", () => {
    expect(applyShellEvent(base, { type: "run.finished", runId: "99" }).activeRunId).toBe("12");
  });
});
