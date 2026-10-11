// Job source adapters (spec §12, UC-03/04). Owned by W4a.
// How an adapter runs (PM2 S26): Research reads the source's skill
// (bots/research/skills/source-<name>/SKILL.md: search URLs, selectors, limits, what to report) and
// scans in Ba's Chrome; this module holds the same knowledge as code — page parsers tested on saved
// HTML fixtures, the normalisers (salary, location, posting date, canonical URL) and the
// ScanOutputChecker the engine runs on every settled research.scan output (PM3 S8).
import type { ScanOutputChecker } from "../engine/scan-check.js";
import { SourceScanChecker } from "./checker.js";

export { SourceScanChecker, type PageVisit, type SourceScanCheckerOptions } from "./checker.js";
export { canonicalJobUrl, jobIdentityKey, sourceOfUrl } from "./canonical-url.js";
export { locationMatches, normaliseLocation } from "./location.js";
export { parsePostedDate } from "./posted-date.js";
export { parseSalary, type ParsedSalary } from "./salary.js";
export { detectBlock, readJobPage, readListingPage } from "./pages.js";
export { scanJobLimit, searchUrls, SOURCE_ADAPTERS } from "./sources.js";

let shared: SourceScanChecker | null = null;

/** Production wiring's checker: one per process, so its empty-scan streaks span runs. */
export function createScanOutputChecker(): ScanOutputChecker {
  shared ??= new SourceScanChecker();
  return shared;
}
