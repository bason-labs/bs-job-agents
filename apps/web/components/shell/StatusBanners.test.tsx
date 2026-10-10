import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MOCK_SHELL_DATA } from "@/lib/mock/shell";
import { HealthBanner, PausedBanner, healthMessage, pausedText } from "./StatusBanners";

const local = (h: number, m: number) => new Date(2026, 9, 10, h, m).getTime();

describe("pausedText (PM S8: clock time and a human countdown)", () => {
  it("reads like 'Claude paused until 14:05 · resumes in 2h 10m'", () => {
    const until = new Date(local(14, 5)).toISOString();
    expect(pausedText("Claude", until, local(11, 55))).toBe("Claude paused until 14:05 · resumes in 2h 10m");
    expect(pausedText("ChatGPT", until, local(14, 4))).toBe("ChatGPT paused until 14:05 · resumes in 1m");
  });
  it("past the reset time it says it is resuming", () => {
    expect(pausedText("Claude", new Date(local(14, 5)).toISOString(), local(14, 6))).toBe("Claude paused until 14:05 · resuming now");
  });
});

describe("PausedBanner", () => {
  it("shows each paused engine and a closed Chrome; nothing when all is well", () => {
    vi.useFakeTimers({ now: local(11, 55) });
    const data = {
      ...MOCK_SHELL_DATA,
      usage: MOCK_SHELL_DATA.usage.map((u) => (u.engine === "claude" ? { ...u, pausedUntil: new Date(local(14, 5)).toISOString() } : u)),
      chromeConnected: false,
    };
    const { rerender } = render(<PausedBanner data={data} />);
    expect(screen.getByRole("status")).toHaveTextContent("Claude paused until 14:05 · resumes in 2h 10m");
    expect(screen.getByRole("status")).toHaveTextContent("Chrome not connected — browser steps waiting");
    expect(screen.getByRole("status")).not.toHaveTextContent("10800");
    rerender(<PausedBanner data={MOCK_SHELL_DATA} />);
    expect(screen.queryByRole("status")).toBeNull();
    vi.useRealTimers();
  });
});

describe("HealthBanner (PM S19 degraded start, unreachable orchestrator)", () => {
  it("names the stale ROLE.md with the fix (PM decision 8 copy)", () => {
    expect(healthMessage({ ok: false, reason: "prompt_version_stale", detail: { bot: "cv" } })).toBe(
      "bots/cv/ROLE.md changed without a version bump. Bump promptVersion in bots/cv/bot.json, then restart.",
    );
  });
  it("explains an unreachable orchestrator and other degraded reasons", () => {
    expect(healthMessage({ ok: false, reason: "unreachable", detail: null })).toMatch(/Can't reach the orchestrator/);
    expect(healthMessage({ ok: false, reason: "schema_guard", detail: "trigger missing" })).toBe(
      "The orchestrator started without its engine (schema_guard: trigger missing). Bots won't run until this is fixed.",
    );
    expect(healthMessage({ ok: true, reason: null, detail: null })).toBeNull();
  });
  it("renders as an alert, and nothing when healthy", () => {
    const { rerender } = render(<HealthBanner health={{ ok: false, reason: "unreachable", detail: null }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Can't reach the orchestrator");
    rerender(<HealthBanner health={{ ok: true, reason: null, detail: null }} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
