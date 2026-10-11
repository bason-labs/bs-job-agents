// The source adapters' settings (W4a, §12): hosts, LinkedIn's limits (UC-03 c) and each board's
// search URL for a search profile (§7.5). Research builds the same URLs from its skills
// (bots/research/skills/source-*/SKILL.md); the checker uses them for "page:" in its reasons.
import { LIMITS, type SearchProfileFieldsBase, type WorkMode } from "@bs-job-agents/shared";
import { normaliseLocation, type City } from "./location.js";
import { slugify } from "./text.js";

export type AdapterSource = "topcv" | "itviec" | "linkedin" | "career_site";

export interface SourceAdapter {
  source: AdapterSource;
  displayName: string;
  /** Domains a posting URL must be on (subdomains included); empty = any public site (career sites). */
  hosts: readonly string[];
  /** Page views per scan (UC-03 c); null = no fixed limit. */
  maxPageViews: number | null;
  /** Random pause between pages, ms (UC-03 c); 0 = none required. */
  minDelayMs: number;
  maxDelayMs: number;
}

export const SOURCE_ADAPTERS: Record<AdapterSource, SourceAdapter> = {
  topcv: { source: "topcv", displayName: "TopCV", hosts: ["topcv.vn"], maxPageViews: null, minDelayMs: 0, maxDelayMs: 0 },
  itviec: { source: "itviec", displayName: "ITviec", hosts: ["itviec.com"], maxPageViews: null, minDelayMs: 0, maxDelayMs: 0 },
  linkedin: {
    source: "linkedin",
    displayName: "LinkedIn",
    hosts: ["linkedin.com"],
    maxPageViews: LIMITS.linkedinMaxPageViews,
    minDelayMs: 3000,
    maxDelayMs: 8000,
  },
  career_site: { source: "career_site", displayName: "Career site", hosts: [], maxPageViews: null, minDelayMs: 0, maxDelayMs: 0 },
};

export function isAdapterSource(source: string): source is AdapterSource {
  return Object.hasOwn(SOURCE_ADAPTERS, source);
}

/** Searches per scan (roles × locations), so one scan stays polite. */
export const MAX_SEARCHES_PER_SCAN = 6;

/**
 * Candidates one scan may return: 3 × maxJobs, at most 30. The fit step (UC-04) keeps the top
 * maxJobs, so a scan reads a few more than it needs.
 */
export function scanJobLimit(maxJobs: number): number {
  return Math.min(Math.max(1, maxJobs) * 3, 30);
}

// Observed 2026-10 on the boards' own location links.
const TOPCV_CITY: Record<City, string> = { "Ho Chi Minh City": "ho-chi-minh-kl2", Hanoi: "ha-noi-kl1", "Da Nang": "da-nang-kl8" };
const ITVIEC_CITY: Record<City, string> = { "Ho Chi Minh City": "ho-chi-minh-hcm", Hanoi: "ha-noi", "Da Nang": "da-nang" };
const LINKEDIN_WORK_MODE: Record<WorkMode, string> = { onsite: "1", remote: "2", hybrid: "3" };

type Criteria = Pick<SearchProfileFieldsBase, "roles" | "locations" | "workModes">;

/** One search URL per role × location (deduplicated, at most MAX_SEARCHES_PER_SCAN). */
export function searchUrls(source: AdapterSource, criteria: Criteria): string[] {
  const urls: string[] = [];
  const locations = criteria.locations.length > 0 ? criteria.locations : [""];
  for (const role of criteria.roles) {
    for (const where of locations) {
      const loc = normaliseLocation(where);
      const city = loc.cities[0] ?? null;
      const roleSlug = slugify(role);
      if (!roleSlug) continue;
      switch (source) {
        case "topcv":
          urls.push(city ? `https://www.topcv.vn/tim-viec-lam-${roleSlug}-tai-${TOPCV_CITY[city]}` : `https://www.topcv.vn/tim-viec-lam-${roleSlug}`);
          break;
        case "itviec":
          urls.push(city ? `https://itviec.com/it-jobs/${roleSlug}/${ITVIEC_CITY[city]}` : `https://itviec.com/it-jobs/${roleSlug}`);
          break;
        case "linkedin": {
          const q = new URLSearchParams({ keywords: role, location: city ? `${city}, Vietnam` : "Vietnam", f_TPR: "r604800" });
          const modes = [...new Set(criteria.workModes)];
          if (modes.length > 0 && modes.length < 3) q.set("f_WT", modes.map((m) => LINKEDIN_WORK_MODE[m]).sort().join(","));
          urls.push(`https://www.linkedin.com/jobs/search?${q.toString()}`);
          break;
        }
        case "career_site":
          break;
      }
    }
  }
  return [...new Set(urls)].slice(0, MAX_SEARCHES_PER_SCAN);
}
