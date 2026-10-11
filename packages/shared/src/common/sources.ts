// Search sources (§7.5 "sources", W5 2026-10-11): what each toggle on the Search criteria screen
// is, how the orchestrator reads it and whether the app may apply there.
// - kind "browser": Research reads the board in Ba's Chrome (a skill per source, §12 adapters).
// - kind "feed": a public JSON/RSS feed the orchestrator fetches itself. No bot, no LLM, no
//   Claude/Codex quota; the scan's fit step (an LLM task) still scores what it finds.
// - canApply false: find only. The job shows up on a review card, but Approve is refused and no
//   bot ever applies, bids or spends anything there (Upwork: no proposals, no Connects).
// - remote: the board lists remote jobs. Its scan ignores the city filter, matches "Remote" and
//   the optional timezoneOverlap, and compares salaries in USD (see REMOTE_SALARY_RULE).
import { SearchSourceSchema, type SearchSource } from "./primitives.js";

export type SourceKind = "browser" | "feed";
export type SourceGroup = "vietnam" | "remote" | "global";

export interface SearchSourceInfo {
  label: string;
  kind: SourceKind;
  canApply: boolean;
  remote: boolean;
  group: SourceGroup;
  /** The board's own domains (a posting URL is on one of them, subdomains included). */
  hosts: readonly string[];
}

export const SEARCH_SOURCES = {
  topcv: { label: "TopCV", kind: "browser", canApply: true, remote: false, group: "vietnam", hosts: ["topcv.vn"] },
  itviec: { label: "ITviec", kind: "browser", canApply: true, remote: false, group: "vietnam", hosts: ["itviec.com"] },
  vietnamworks: { label: "VietnamWorks", kind: "browser", canApply: true, remote: false, group: "vietnam", hosts: ["vietnamworks.com"] },
  remoteok: { label: "Remote OK", kind: "feed", canApply: true, remote: true, group: "remote", hosts: ["remoteok.com"] },
  weworkremotely: { label: "We Work Remotely", kind: "feed", canApply: true, remote: true, group: "remote", hosts: ["weworkremotely.com"] },
  remotive: { label: "Remotive", kind: "feed", canApply: true, remote: true, group: "remote", hosts: ["remotive.com"] },
  jobspresso: { label: "Jobspresso", kind: "feed", canApply: true, remote: true, group: "remote", hosts: ["jobspresso.co"] },
  linkedin: { label: "LinkedIn", kind: "browser", canApply: true, remote: false, group: "global", hosts: ["linkedin.com"] },
  wellfound: { label: "Wellfound", kind: "browser", canApply: true, remote: true, group: "global", hosts: ["wellfound.com"] },
  upwork: { label: "Upwork", kind: "browser", canApply: false, remote: true, group: "global", hosts: ["upwork.com"] },
} as const satisfies Record<SearchSource, SearchSourceInfo>;

export const SOURCE_GROUPS = [
  { group: "vietnam", label: "Vietnam boards" },
  { group: "remote", label: "Remote boards" },
  { group: "global", label: "Global" },
] as const satisfies readonly { group: SourceGroup; label: string }[];

/** The toggles of one group, in SearchSourceSchema order. */
export function sourcesInGroup(group: SourceGroup): SearchSource[] {
  return SearchSourceSchema.options.filter((s) => SEARCH_SOURCES[s].group === group);
}

export const FEED_SOURCES = SearchSourceSchema.options.filter((s) => SEARCH_SOURCES[s].kind === "feed");
export type FeedSource = (typeof FEED_SOURCES)[number];

export function isSearchSource(source: unknown): source is SearchSource {
  return typeof source === "string" && (SearchSourceSchema.options as readonly string[]).includes(source);
}

/** A source the orchestrator fetches itself (no bot). */
export function isFeedSource(source: unknown): source is FeedSource {
  return isSearchSource(source) && SEARCH_SOURCES[source].kind === "feed";
}

/** A board that lists remote jobs (city filter ignored; timezoneOverlap and USD salaries apply). */
export function isRemoteSource(source: unknown): boolean {
  return isSearchSource(source) && SEARCH_SOURCES[source].remote;
}

/** Any remote board among `sources` (the criteria screen then shows the time-zone overlap field). */
export function anyRemoteSource(sources: readonly string[]): boolean {
  return sources.some(isRemoteSource);
}

/** Source label for any job source key (unknown keys as written). */
export function sourceLabel(source: string): string {
  return isSearchSource(source) ? SEARCH_SOURCES[source].label : source;
}

/** Find-only sources: the app never applies there. */
export const FIND_ONLY_SOURCES = SearchSourceSchema.options.filter((s) => !SEARCH_SOURCES[s].canApply);

/** Error code (API `details.reason`) when Approve is refused for a find-only job. */
export const FIND_ONLY_REASON = "find_only";

/** The copy Ba sees on a find-only card and in the refusal. */
export const FIND_ONLY_NOTE = "Find only — apply yourself on Upwork. The app never sends bids or proposals and never spends Connects.";

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/**
 * The find-only source a job belongs to (by its source, or by its URL for a pasted link), or null
 * when the app may apply. Upwork is the only one today.
 */
export function findOnlySourceOf(job: { source: string; url: string | null }): SearchSource | null {
  if (isSearchSource(job.source) && !SEARCH_SOURCES[job.source].canApply) return job.source;
  const host = hostOf(job.url);
  if (!host) return null;
  for (const s of FIND_ONLY_SOURCES) {
    if (SEARCH_SOURCES[s].hosts.some((d) => host === d || host.endsWith(`.${d}`))) return s;
  }
  return null;
}

/**
 * How remote boards treat the minimum salary (§7.5 "minimum salary + currency" is monthly):
 * - currency USD: a posting's USD range is turned into a monthly figure (a yearly amount ÷ 12, an
 *   hourly one × 160) and dropped only when even its top is under the floor;
 * - currency VND, or a posting in another currency or without an amount: no salary filter (no
 *   exchange rate is guessed); the fit step still sees the salary text.
 */
export const REMOTE_SALARY_RULE =
  "Remote boards compare salaries in USD: with a USD minimum, a posting is dropped only when even the top of its range (per month: yearly ÷ 12, hourly × 160) is under it; with a VND minimum, or a posting in another currency or without an amount, no salary filter applies.";
