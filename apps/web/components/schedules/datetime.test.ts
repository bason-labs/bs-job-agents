import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatDayDate, formatDayTime, isoDay } from "./datetime";

// Times are shown in Asia/Ho_Chi_Minh (spec §7.4, §15.2), whatever the machine's zone,
// so the server render and the browser agree.

describe("formatDateTime", () => {
  it("formats an ISO time as YYYY-MM-DD HH:MM in Asia/Ho_Chi_Minh (prototype style)", () => {
    expect(formatDateTime("2026-10-10T15:40:00+07:00")).toBe("2026-10-10 15:40");
    expect(formatDateTime("2026-10-10T08:40:00Z")).toBe("2026-10-10 15:40");
    // Crosses midnight in Vietnam.
    expect(formatDateTime("2026-10-10T18:05:00Z")).toBe("2026-10-11 01:05");
  });

  it("uses a 24-hour clock and pads hours", () => {
    expect(formatDateTime("2026-10-10T00:05:00+07:00")).toBe("2026-10-10 00:05");
    expect(formatDateTime("2026-10-10T23:30:00+07:00")).toBe("2026-10-10 23:30");
  });

  it("shows a dash for a missing or invalid time", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime("not a date")).toBe("—");
  });
});

describe("formatDate", () => {
  it("formats the calendar day in Asia/Ho_Chi_Minh", () => {
    expect(formatDate("2026-10-10T08:00:00+07:00")).toBe("2026-10-10");
    expect(formatDate("2026-10-10T20:00:00Z")).toBe("2026-10-11");
    expect(formatDate(null)).toBe("—");
  });
});

describe("formatDayTime / formatDayDate (schedule rows)", () => {
  it("formats the next run like the prototype: Mon 12 Oct, 09:00", () => {
    expect(formatDayTime("2026-10-12T09:00:00+07:00")).toBe("Mon 12 Oct, 09:00");
    expect(formatDayTime("2026-10-12T02:00:00Z")).toBe("Mon 12 Oct, 09:00");
    expect(formatDayTime(null)).toBe("—");
  });

  it("formats a day without the time: Fri 9 Oct", () => {
    expect(formatDayDate("2026-10-09T09:00:00+07:00")).toBe("Fri 9 Oct");
  });
});

describe("isoDay", () => {
  it("returns the YYYY-MM-DD day for file names in Asia/Ho_Chi_Minh", () => {
    expect(isoDay(new Date("2026-10-10T20:00:00Z"))).toBe("2026-10-11");
  });
});
