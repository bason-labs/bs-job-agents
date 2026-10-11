// Where a remote posting hires, as UTC offset ranges (W5, search profile `timezoneOverlap`).
// The boards state it in free text: "Anywhere in the World", "USA Only", "Europe, USA, Canada,
// APAC", "United States (EST Time Zone)", "UTC-3 to UTC+3". A posting is dropped only when its
// stated region is clearly outside Ba's overlap; worldwide, Vietnam and unknown places are kept.
import type { OffsetRange } from "@bs-job-agents/shared";
import { foldText } from "../text.js";

export interface PostingRegion {
  /** "Worldwide", "Anywhere", "Global", or Vietnam named among the places. */
  open: boolean;
  /** Offsets of the places named (empty when none was recognised). */
  ranges: OffsetRange[];
}

const r = (from: number, to: number): OffsetRange => ({ from, to });

/** Places and zones as they appear on the boards (folded), with the offsets they work in. */
const PLACES: readonly [RegExp, OffsetRange][] = [
  // regions
  [/\b(apac|asia[- ]pacific)\b/, r(5, 12)],
  [/\b(south ?east asia|sea region)\b/, r(7, 8)],
  [/\basia\b/, r(5, 9)],
  [/\b(oceania|australia|new zealand|anz)\b/, r(8, 12)],
  [/\bemea\b/, r(0, 4)],
  [/\b(europe|european union|eu|cet|cest|eet|uk|united kingdom|great britain|ireland|portugal|spain|france|germany|netherlands|belgium|italy|poland|czechia|czech republic|austria|switzerland|sweden|norway|denmark|finland|estonia|latvia|lithuania|romania|bulgaria|greece|hungary|croatia|serbia|ukraine|iceland|luxembourg|malta|cyprus|slovakia|slovenia)\b/, r(0, 3)],
  [/\b(middle east|israel|turkey|uae|dubai|saudi)\b/, r(2, 4)],
  [/\b(africa|south africa|nigeria|kenya|egypt|morocco|ghana)\b/, r(0, 3)],
  [/\b(americas|north america|latam|latin america|south america|usa|u\.s\.a?|united states|us only|us-based|us based|us states|us timezones?|canada|mexico|brazil|argentina|colombia|chile|peru|uruguay|costa rica|est|edt|pst|pdt|cst|cdt|mst|eastern time|pacific time|central time|mountain time)\b/, r(-8, -3)],
  // countries in Asia and around it
  [/\b(india|sri lanka)\b/, r(5.5, 5.5)],
  [/\b(pakistan)\b/, r(5, 5)],
  [/\b(bangladesh)\b/, r(6, 6)],
  [/\b(thailand|indonesia|cambodia|laos)\b/, r(7, 9)],
  [/\b(singapore|philippines|malaysia|china|hong kong|taiwan)\b/, r(8, 8)],
  [/\b(japan|korea|south korea)\b/, r(9, 9)],
];

const OPEN = /\b(worldwide|world ?wide|anywhere|global(ly)?|everywhere|all countries|any (country|location|time ?zone))\b/;
const VIETNAM = /\b(viet ?nam|ho chi minh|hanoi|ha noi|da nang|saigon)\b/;
const UTC_OFFSET = /\b(?:utc|gmt)\s*([+\-−–])\s*(\d{1,2})(?::?(\d{2}))?/g;

/** The places a posting's region text names, as offsets. */
export function postingRegion(text: string | null | undefined): PostingRegion {
  const raw = text ?? "";
  const t = foldText(raw).replace(/[–—]/g, "-");
  const ranges: OffsetRange[] = [];
  // "US" in capitals (lowercase "us" is a word).
  if (/\bUS\b/.test(raw)) ranges.push(r(-8, -3));
  for (const [re, range] of PLACES) if (re.test(t)) ranges.push(range);
  const offsets = [...t.matchAll(UTC_OFFSET)].map((m) => (m[1] === "+" ? 1 : -1) * (Number(m[2]) + Number(m[3] ?? 0) / 60));
  if (offsets.length >= 2 && /\bto\b|-/.test(t)) ranges.push(r(Math.min(...offsets), Math.max(...offsets)));
  else for (const o of offsets) ranges.push(r(o, o));
  return { open: OPEN.test(t) || VIETNAM.test(t), ranges };
}

/**
 * Does a posting's region fit Ba's overlap? No overlap set, an open region (worldwide, Vietnam) or
 * an unrecognised one → yes; otherwise one of its places must fall within the overlap.
 */
export function regionFits(regionText: string | null | undefined, overlap: OffsetRange | null): boolean {
  if (!overlap) return true;
  const region = postingRegion(regionText);
  if (region.open || region.ranges.length === 0) return true;
  return region.ranges.some((x) => x.from <= overlap.to && x.to >= overlap.from);
}
