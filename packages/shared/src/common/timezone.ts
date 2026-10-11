// Search profile `timezoneOverlap` (W5, remote boards): the working hours Ba can share with a remote
// team, as a range of UTC offsets. Written as a region ("Asia", "APAC", "Europe") or a UTC offset
// with a window ("UTC+7 ±3h"; a bare "UTC+7" means ±2 h). A region may also take a window
// ("Asia ±2h" widens Asia by 2 h on each side). Null on the profile = no time-zone filter.
import { z } from "zod";

/** Region names and the UTC offsets their teams work in (hours, inclusive). */
export const TIMEZONE_REGIONS = {
  asia: { label: "Asia", from: 5, to: 9 },
  apac: { label: "APAC", from: 5, to: 12 },
  "southeast asia": { label: "Southeast Asia", from: 7, to: 8 },
  oceania: { label: "Oceania", from: 8, to: 12 },
  europe: { label: "Europe", from: 0, to: 3 },
  emea: { label: "EMEA", from: 0, to: 4 },
  africa: { label: "Africa", from: 0, to: 3 },
  "middle east": { label: "Middle East", from: 2, to: 4 },
  americas: { label: "Americas", from: -8, to: -3 },
  "north america": { label: "North America", from: -8, to: -4 },
  latam: { label: "LATAM", from: -6, to: -3 },
} as const satisfies Record<string, { label: string; from: number; to: number }>;

export type TimezoneRegion = keyof typeof TIMEZONE_REGIONS;

/** A range of UTC offsets in hours, inclusive (from ≤ to). */
export interface OffsetRange {
  from: number;
  to: number;
}

export const DEFAULT_OVERLAP_WINDOW_HOURS = 2;

const ALIASES: Record<string, TimezoneRegion> = {
  "asia pacific": "apac",
  "asia-pacific": "apac",
  sea: "southeast asia",
  "south east asia": "southeast asia",
  eu: "europe",
  "latin america": "latam",
  "south america": "latam",
  "north american": "north america",
  australia: "oceania",
};

const WINDOW = /(?:±|\+\/-|\+-)\s*(\d{1,2}(?:\.\d)?)\s*(?:h|hrs?|hours?)?$/i;
const OFFSET = /^(?:utc|gmt)?\s*([+\-−])\s*(\d{1,2})(?::?(\d{2}))?$/i;

/** "UTC+7 ±3h" → { from: 4, to: 10 }; "Asia" → { from: 5, to: 9 }; anything else → null. */
export function parseTimezoneOverlap(text: string | null | undefined): OffsetRange | null {
  let t = (text ?? "").trim().replace(/\s+/g, " ");
  if (!t) return null;
  let window: number | null = null;
  const w = WINDOW.exec(t);
  if (w) {
    window = Number(w[1]);
    t = t.slice(0, w.index).trim();
  }
  if (window !== null && (window < 0 || window > 12)) return null;
  const name = t.toLowerCase();
  const region = (Object.hasOwn(TIMEZONE_REGIONS, name) ? name : ALIASES[name]) as TimezoneRegion | undefined;
  if (region) {
    const r = TIMEZONE_REGIONS[region];
    return { from: r.from - (window ?? 0), to: r.to + (window ?? 0) };
  }
  if (/^(utc|gmt)$/i.test(t)) t = "+0";
  const m = OFFSET.exec(t);
  if (!m) return null;
  const sign = m[1] === "+" ? 1 : -1;
  const offset = sign * (Number(m[2]) + Number(m[3] ?? 0) / 60);
  if (offset < -12 || offset > 14) return null;
  const span = window ?? DEFAULT_OVERLAP_WINDOW_HOURS;
  return { from: offset - span, to: offset + span };
}

export const TimezoneOverlapSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((v) => parseTimezoneOverlap(v) !== null, {
    message: "use a region (Asia, APAC, Europe, Americas…) or a UTC offset with a window, e.g. UTC+7 ±3h",
  })
  .describe("Remote boards only: the time zones Ba can overlap with, e.g. Asia or UTC+7 ±3h. Null = no filter.");
