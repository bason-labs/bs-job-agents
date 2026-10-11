import type { AppEvent } from "@bs-job-agents/shared";
import { sampleEvents } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { MOCK_SHELL_DATA } from "@/lib/mock/shell";
import type { EventFeed, EventListener } from "./contract";
import { affectsReviewCount, applyShellEvent, subscribeShellEvents, type ShellEvent } from "./live";

const event = <T extends AppEvent["type"]>(type: T) => sampleEvents.find((e) => e.type === type) as Extract<AppEvent, { type: T }>;

describe("subscribeShellEvents", () => {
  it("maps feed events onto shell events and ignores the rest", () => {
    let listener: EventListener | null = null;
    const feed: EventFeed = {
      subscribe: (l) => {
        listener = l;
        return () => (listener = null);
      },
      getStatus: () => "open",
      onStatus: () => () => {},
    };
    const got: ShellEvent[] = [];
    const off = subscribeShellEvents(feed, (e) => got.push(e));
    listener!(event("engine.paused"));
    listener!(event("task.progress"));
    listener!(event("bridge.status"));
    expect(got).toEqual([
      { type: "engine.paused", engine: "claude", pausedUntil: "2026-10-10T14:05:00+07:00" },
      { type: "chrome.status", connected: false },
    ]);
    off();
    expect(listener).toBeNull();
  });

  it("knows which events can change the review count", () => {
    expect(affectsReviewCount(event("review.ready"))).toBe(true);
    expect(affectsReviewCount(event("run.finished"))).toBe(true);
    expect(affectsReviewCount({ ...event("step.finished"), stepKey: "review" })).toBe(true);
    expect(affectsReviewCount(event("step.finished"))).toBe(false);
    expect(affectsReviewCount(event("task.progress"))).toBe(false);
  });
});

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

  it("replaces everything after a fresh read", () => {
    const fresh = { ...base, reviewCount: 9, activeRunId: null };
    expect(applyShellEvent(base, { type: "shell.replace", data: fresh })).toBe(fresh);
  });
});
