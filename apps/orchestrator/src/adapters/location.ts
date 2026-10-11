// Location text → the three big Vietnamese IT cities plus remote (W4a, §7.5 locations).
// "Hồ Chí Minh", "TP.HCM", "Sài Gòn", "Ho Chi Minh City Metropolitan Area" → Ho Chi Minh City;
// "Hà Nội", "Ha Noi" → Hanoi; "Đà Nẵng", "Danang" → Da Nang. Other places are kept as written.
import { cleanText, foldText } from "./text.js";

export const CITIES = ["Ho Chi Minh City", "Hanoi", "Da Nang"] as const;
export type City = (typeof CITIES)[number];

export interface NormalisedLocation {
  /** Known cities, in the order they appear. */
  cities: City[];
  remote: boolean;
  /** Places that are not one of the known cities, as written. */
  other: string[];
}

const CITY_PATTERNS: readonly [City, RegExp][] = [
  ["Ho Chi Minh City", /\b(ho chi minh|hcmc?|tp\.? ?hcm|tphcm|sai gon|saigon)\b/],
  ["Hanoi", /\b(ha noi|hanoi|hn)\b/],
  ["Da Nang", /\b(da nang|danang)\b/],
];
const REMOTE = /\b(remote|tu xa|wfh|work from home)\b/;

export function normaliseLocation(text: string | null | undefined): NormalisedLocation {
  const folded = foldText(text);
  const found: { city: City; at: number }[] = [];
  for (const [city, re] of CITY_PATTERNS) {
    const m = re.exec(folded);
    if (m) found.push({ city, at: m.index });
  }
  const remote = REMOTE.test(folded);
  const other: string[] = [];
  if (found.length === 0 && !remote) {
    const kept = cleanText(text);
    if (kept) other.push(kept);
  }
  return { cities: found.sort((a, b) => a.at - b.at).map((f) => f.city), remote, other };
}

/** Does a job's location fit one of the search profile's locations? */
export function locationMatches(jobLocation: string, wanted: readonly string[]): boolean {
  const job = normaliseLocation(jobLocation);
  return wanted.some((w) => {
    const want = normaliseLocation(w);
    if (want.remote && job.remote) return true;
    if (want.cities.some((c) => job.cities.includes(c))) return true;
    return want.other.some((o) => foldText(jobLocation).includes(foldText(o)));
  });
}
