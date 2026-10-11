// Date/time display for the W3c screens (Applications, Search criteria, Schedules, Master CV).
// Always in Asia/Ho_Chi_Minh (spec §7.4, §15.2), so the server render, the browser and the
// tests agree whatever the machine's zone is.
import { DEFAULT_TIMEZONE } from "@bs-job-agents/shared";

type Parts = { year: string; month: string; day: string; hour: string; minute: string; weekday: string; monthShort: string };

const numeric = new Intl.DateTimeFormat("en-US", {
  timeZone: DEFAULT_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const words = new Intl.DateTimeFormat("en-GB", { timeZone: DEFAULT_TIMEZONE, weekday: "short", month: "short" });

function parts(value: string | Date | null | undefined): Parts | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const get = (fmt: Intl.DateTimeFormat, type: Intl.DateTimeFormatPartTypes) => fmt.formatToParts(date).find((p) => p.type === type)?.value ?? "";
  return {
    year: get(numeric, "year"),
    month: get(numeric, "month"),
    day: get(numeric, "day"),
    // Some engines print midnight as "24" even with h23; normalise.
    hour: get(numeric, "hour").replace(/^24$/, "00"),
    minute: get(numeric, "minute"),
    weekday: get(words, "weekday"),
    monthShort: get(words, "month"),
  };
}

const DASH = "—";

/** 2026-10-10 15:40 (prototype style). */
export function formatDateTime(value: string | Date | null | undefined): string {
  const p = parts(value);
  return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` : DASH;
}

/** 2026-10-10 */
export function formatDate(value: string | Date | null | undefined): string {
  const p = parts(value);
  return p ? `${p.year}-${p.month}-${p.day}` : DASH;
}

/** Mon 13 Oct, 09:00 (schedule rows: next run). */
export function formatDayTime(value: string | Date | null | undefined): string {
  const p = parts(value);
  return p ? `${p.weekday} ${Number(p.day)} ${p.monthShort}, ${p.hour}:${p.minute}` : DASH;
}

/** Fri 10 Oct */
export function formatDayDate(value: string | Date | null | undefined): string {
  const p = parts(value);
  return p ? `${p.weekday} ${Number(p.day)} ${p.monthShort}` : DASH;
}

/** YYYY-MM-DD of `date` in Asia/Ho_Chi_Minh (file names). */
export function isoDay(date: Date): string {
  return formatDate(date);
}
