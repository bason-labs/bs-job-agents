import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("PausedBanner: Resume now (live run 1, POST /engines/:engine/resume)", () => {
  const paused = {
    ...MOCK_SHELL_DATA,
    usage: MOCK_SHELL_DATA.usage.map((u) => (u.engine === "claude" ? { ...u, pausedUntil: new Date(Date.now() + 3600_000).toISOString() } : u)),
    chromeConnected: true,
  };
  it("a paused engine offers Resume now, which calls onResume with that engine", async () => {
    const onResume = vi.fn(async () => {});
    render(<PausedBanner data={paused} onResume={onResume} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume Claude now" }));
    await waitFor(() => expect(onResume).toHaveBeenCalledWith("claude"));
    expect(screen.getByRole("button", { name: "Resume Claude now" })).toHaveTextContent("Resume now");
  });
  it("shows the error when the orchestrator refuses", async () => {
    const onResume = vi.fn(async () => {
      throw new Error("claude is not paused");
    });
    render(<PausedBanner data={paused} onResume={onResume} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume Claude now" }));
    expect(await screen.findByText(/claude is not paused/)).toBeInTheDocument();
  });
  it("no button without a handler, and none for Chrome", () => {
    render(<PausedBanner data={{ ...paused, chromeConnected: false }} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("HealthBanner (PM S19 degraded start, unreachable orchestrator)", () => {
  it("names the stale ROLE.md with the fix (PM decision 8 copy), from the orchestrator's detail", () => {
    const detail = "bots/cv/ROLE.md changed but promptVersion is still 4: bump promptVersion in bots/cv/bot.json";
    expect(healthMessage({ ok: false, reason: "prompt_version_stale", detail })).toBe(
      "bots/cv/ROLE.md changed without a version bump. Bump promptVersion in bots/cv/bot.json, then restart.",
    );
  });
  it("explains an unreachable orchestrator and the other degraded reasons", () => {
    expect(healthMessage({ ok: false, reason: "unreachable", detail: null })).toMatch(/Can't reach the orchestrator/);
    expect(healthMessage({ ok: false, reason: "schema_guard", detail: "applications_no_update trigger missing" })).toBe(
      "The database is missing one of its safety triggers: applications_no_update trigger missing. Bots won't run until this is fixed.",
    );
    expect(healthMessage({ ok: false, reason: "data_dir_invalid", detail: "the data folder /x (y) has a parenthesis" })).toMatch(/^The data folder can't be used: /);
    expect(healthMessage({ ok: false, reason: "something_new", detail: null })).toBe(
      "The orchestrator runs in degraded mode (something_new). Bots won't run until this is fixed.",
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
