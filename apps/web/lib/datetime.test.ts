import { describe, expect, it } from "vitest";
import { formatClock, formatDuration, formatElapsed, formatWhen } from "./datetime";

// Times are shown in the machine's zone; build them from local parts so the test is zone-proof.
const local = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

describe("formatDuration (PM S8: human time, never raw seconds)", () => {
  it.each([
    [0, "0s"],
    [45_000, "45s"],
    [59_400, "59s"],
    [60_000, "1m"],
    [12 * 60_000 + 20_000, "13m"],
    [3 * 3600_000, "3h"],
    [2 * 3600_000 + 10 * 60_000, "2h 10m"],
    [26 * 3600_000 + 5 * 60_000, "1d 2h"],
  ])("%i ms → %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
  it("never shows a negative wait", () => {
    expect(formatDuration(-5000)).toBe("0s");
  });
});

describe("formatClock", () => {
  const now = local(2026, 10, 10, 11, 55);
  it("today: the time only (Claude paused until 14:05)", () => {
    expect(formatClock(new Date(local(2026, 10, 10, 14, 5)).toISOString(), now)).toBe("14:05");
  });
  it("another day: weekday, date and time", () => {
    expect(formatClock(new Date(local(2026, 10, 13, 9, 0)).toISOString(), now)).toBe("Tue 13 Oct, 09:00");
  });
});

describe("formatWhen / formatElapsed", () => {
  it("message times: clock today, date before", () => {
    const now = local(2026, 10, 10, 18, 0);
    expect(formatWhen(new Date(local(2026, 10, 10, 9, 0, 4)).toISOString(), now)).toBe("09:00");
    expect(formatWhen(new Date(local(2026, 10, 9, 15, 2)).toISOString(), now)).toBe("9 Oct, 15:02");
  });
  it("step durations from start and finish", () => {
    const start = new Date(local(2026, 10, 10, 9, 0, 5)).toISOString();
    expect(formatElapsed(start, new Date(local(2026, 10, 10, 9, 6, 40)).toISOString())).toBe("6m 35s");
    expect(formatElapsed(start, new Date(local(2026, 10, 10, 9, 0, 9)).toISOString())).toBe("4s");
    expect(formatElapsed(null, null)).toBe("—");
    expect(formatElapsed(start, null, local(2026, 10, 10, 9, 1, 5))).toBe("1m 0s");
  });
});
