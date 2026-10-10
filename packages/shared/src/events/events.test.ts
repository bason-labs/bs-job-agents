import { describe, expect, it } from "vitest";
import { sampleEvents } from "../fixtures/events.js";
import {
  APP_EVENT_TYPES,
  AppEventSchema,
  type AppEvent,
  decodeSseData,
  encodeSseEvent,
  isEventType,
  matchesEventPattern,
} from "./events.js";

describe("AppEvent union (§11 live updates)", () => {
  it("includes every event the spec names", () => {
    expect(APP_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        "run.started",
        "run.updated",
        "run.finished",
        "step.started",
        "step.updated",
        "step.finished",
        "task.progress",
        "engine.paused",
        "engine.resumed",
        "review.ready",
        "application.updated",
      ]),
    );
  });

  it("has a valid sample for every event type", () => {
    const covered = new Set(sampleEvents.map((e) => e.type));
    expect([...covered].sort()).toEqual([...APP_EVENT_TYPES].sort());
    for (const e of sampleEvents) {
      const r = AppEventSchema.safeParse(e);
      expect(r.success, `${e.type}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
    }
  });

  it("discriminates on type", () => {
    const e = AppEventSchema.parse(sampleEvents.find((x) => x.type === "engine.paused"));
    if (e.type !== "engine.paused") throw new Error("wrong branch");
    // type-narrowed field access
    expect(e.engine).toBe("claude");
    expect(e.until).toBe("2026-10-10T14:05:00+07:00");
  });

  it("rejects an unknown type", () => {
    expect(AppEventSchema.safeParse({ id: "1", at: "2026-10-10T09:00:00+07:00", type: "run.exploded", runId: "r" }).success).toBe(false);
  });

  it("rejects a payload that belongs to another type", () => {
    const progress = sampleEvents.find((x) => x.type === "task.progress")!;
    expect(AppEventSchema.safeParse({ ...progress, type: "engine.paused" }).success).toBe(false);
  });

  it("rejects missing base fields", () => {
    const { at: _at, ...noAt } = sampleEvents[0]!;
    expect(AppEventSchema.safeParse(noAt).success).toBe(false);
  });

  it("task.paused carries a structured pause reason", () => {
    const paused = sampleEvents.find((x) => x.type === "task.paused")!;
    expect(AppEventSchema.safeParse({ ...paused, reason: { code: "needs_login", site: null, detail: null } }).success).toBe(false);
  });

  it("isEventType narrows", () => {
    const e: AppEvent = sampleEvents.find((x) => x.type === "review.ready")!;
    expect(isEventType(e, "review.ready") && e.jobId).toBe("job_1");
    expect(isEventType(e, "run.started")).toBe(false);
  });

  it("matchesEventPattern supports run.* style patterns", () => {
    expect(matchesEventPattern("run.started", "run.*")).toBe(true);
    expect(matchesEventPattern("step.updated", "run.*")).toBe(false);
    expect(matchesEventPattern("task.progress", "task.progress")).toBe(true);
    expect(matchesEventPattern("engine.paused", "*")).toBe(true);
  });
});

describe("SSE encoding", () => {
  it("round-trips through the SSE frame", () => {
    const e = sampleEvents.find((x) => x.type === "task.progress")!;
    const frame = encodeSseEvent(e);
    expect(frame).toMatch(/^id: .+\nevent: task\.progress\ndata: .+\n\n$/);
    const data = frame.split("\n").find((l) => l.startsWith("data: "))!.slice(6);
    expect(decodeSseData(data)).toEqual(e);
  });

  it("keeps multi-line text on one data line", () => {
    const e = { ...sampleEvents.find((x) => x.type === "task.progress")!, text: "line1\nline2" } as AppEvent;
    expect(encodeSseEvent(e).split("\n").filter((l) => l.startsWith("data: "))).toHaveLength(1);
  });

  it("decodeSseData throws on invalid payloads", () => {
    expect(() => decodeSseData("{\"type\":\"nope\"}")).toThrow();
    expect(() => decodeSseData("not json")).toThrow();
  });
});
