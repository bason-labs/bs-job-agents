import { describe, expect, it } from "vitest";
import { EngineUsageSchema } from "@bs-job-agents/shared";
import { claudeLines, codexLines } from "./__fixtures__/index.js";
import { detectCodexUsageLimit, isClaudeLimitMessage, readClaudeRateLimit, type ClaudeRateLimitInfo } from "./usage.js";

function rateLimitInfo(lines: string[]): ClaudeRateLimitInfo {
  const line = lines.find((l) => l.includes('"rate_limit_event"'));
  return (JSON.parse(line!) as { rate_limit_info: ClaudeRateLimitInfo }).rate_limit_info;
}

const iso = (epochSec: number) => new Date(epochSec * 1000).toISOString();

describe("readClaudeRateLimit (UC-16, spike S1)", () => {
  it("reads the real rate_limit_event: windows and reset, not limited", () => {
    const r = readClaudeRateLimit(rateLimitInfo(claudeLines("structuredOk")));
    expect(r.usage).toEqual({ fiveHour: 0.28, sevenDay: 0.22, resetsAt: iso(1791664800) });
    expect(r.limited).toBe(false);
    expect(EngineUsageSchema.safeParse(r.usage).success).toBe(true);
  });

  it("limits at ≥ 0.95 utilization before the wall (synthetic, status allowed_warning)", () => {
    const r = readClaudeRateLimit(rateLimitInfo(claudeLines("highUtilization")));
    expect(r.limited).toBe(true);
    expect(r.usage.fiveHour).toBe(0.96);
    expect(r.usage.resetsAt).toBe(iso(1791664800));
  });

  it("limits when status is rejected (synthetic)", () => {
    const r = readClaudeRateLimit(rateLimitInfo(claudeLines("usageLimit")));
    expect(r.limited).toBe(true);
    expect(r.usage.resetsAt).toBe(iso(1791664800));
  });

  it("allowed_warning below the threshold is not a limit", () => {
    const r = readClaudeRateLimit({ status: "allowed_warning", resetsAt: 100, unifiedWindows: { five_hour: { utilization: 0.8, resetsAt: 100 } } });
    expect(r.limited).toBe(false);
  });

  it("an unknown status counts as limited", () => {
    expect(readClaudeRateLimit({ status: "blocked_somehow" }).limited).toBe(true);
  });

  it("waits for the 7-day window when that one is full, and for the later reset when both are", () => {
    const sevenDay = readClaudeRateLimit({
      status: "allowed",
      resetsAt: 1000,
      unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1000 }, seven_day: { utilization: 0.97, resetsAt: 9000 } },
    });
    expect(sevenDay).toMatchObject({ limited: true, usage: { resetsAt: iso(9000) } });
    const both = readClaudeRateLimit({
      status: "rejected",
      resetsAt: 1000,
      unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1000 }, seven_day: { utilization: 0.99, resetsAt: 9000 } },
    });
    expect(both.usage.resetsAt).toBe(iso(9000));
  });

  it("tolerates missing windows and clamps utilization to 0–1", () => {
    expect(readClaudeRateLimit({ status: "allowed" }).usage).toEqual({ fiveHour: null, sevenDay: null, resetsAt: null });
    const r = readClaudeRateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: 1.2 } } });
    expect(r.usage.fiveHour).toBe(1);
    expect(r.limited).toBe(true);
    expect(EngineUsageSchema.safeParse(r.usage).success).toBe(true);
  });

  it("uses a custom threshold", () => {
    expect(readClaudeRateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.8 } } }, 0.75).limited).toBe(true);
  });
});

describe("isClaudeLimitMessage", () => {
  it.each([
    "You've hit your limit · resets 3:40am (Asia/Saigon)",
    "Usage limit reached",
    "Claude AI usage limit reached|1791664800",
    "You've hit your session limit · resets 2pm",
  ])("detects %s", (text) => {
    expect(isClaudeLimitMessage(text)).toBe(true);
  });

  it("ignores other errors", () => {
    expect(isClaudeLimitMessage("There's an issue with the selected model (claude-nonexistent-model-x).")).toBe(false);
    expect(isClaudeLimitMessage("Context limit reached")).toBe(false);
  });
});

describe("detectCodexUsageLimit (UC-16)", () => {
  const message = (lines: string[]) => (JSON.parse(lines.find((l) => l.includes('"turn.failed"'))!) as { error: { message: string } }).error.message;

  it("reads resets_at from the API body (synthetic)", () => {
    const now = new Date("2026-10-11T01:00:00Z");
    expect(detectCodexUsageLimit(message(codexLines("usageLimitJson")), now)).toEqual({ limited: true, resetsAt: iso(1791670000) });
  });

  it("parses 'try again at 3:45 PM' as the next 3:45 PM local time (synthetic)", () => {
    const morning = new Date(2026, 9, 11, 9, 0, 0);
    const expected = new Date(2026, 9, 11, 15, 45, 0).toISOString();
    expect(detectCodexUsageLimit(message(codexLines("usageLimit")), morning)).toEqual({ limited: true, resetsAt: expected });
    const evening = new Date(2026, 9, 11, 18, 0, 0);
    const tomorrow = new Date(2026, 9, 12, 15, 45, 0).toISOString();
    expect(detectCodexUsageLimit(message(codexLines("usageLimit")), evening).resetsAt).toBe(tomorrow);
  });

  it("parses 24-hour times, explicit dates and 'try again in …'", () => {
    const now = new Date(2026, 9, 11, 9, 0, 0);
    expect(detectCodexUsageLimit("You've hit your usage limit. Try again at 17:05.", now).resetsAt).toBe(new Date(2026, 9, 11, 17, 5).toISOString());
    expect(detectCodexUsageLimit("You've hit your usage limit. Try again at 13 Oct 2026 9:30 AM.", now).resetsAt).toBe(
      new Date(2026, 9, 13, 9, 30).toISOString(),
    );
    expect(detectCodexUsageLimit("You've hit your usage limit, try again in 2 hours 3 minutes", now).resetsAt).toBe(
      new Date(now.getTime() + (2 * 60 + 3) * 60_000).toISOString(),
    );
    expect(detectCodexUsageLimit("usage_limit_reached; try again in 90s", now).resetsAt).toBe(new Date(now.getTime() + 90_000).toISOString());
  });

  it("is limited with an unknown reset when the time cannot be parsed (retry every 30 min)", () => {
    expect(detectCodexUsageLimit("Usage limit reached. You've reached your usage limit.", new Date())).toEqual({ limited: true, resetsAt: null });
  });

  it("does not flag other failures (real 400 invalid_json_schema)", () => {
    expect(detectCodexUsageLimit(message(codexLines("turnFailed")), new Date())).toEqual({ limited: false, resetsAt: null });
  });
});
