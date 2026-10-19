// PM3 S8: the scan-output check port (UC-03 b, UC-03 c, §12 source adapters). Where a
// research.scan output settles (schema and self-check already passed), the engine asks a
// ScanOutputChecker whether the output is believable for its source:
//   { ok: true }                                   accept (the default)
//   { ok: false, adapterBroken: false, reason }    implausible output → the attempt fails and is
//                                                  retried like any failed attempt
//   { ok: false, adapterBroken: true, reason,      the source's layout changed or the adapter no
//     screenshot? }                                longer works → the branch fails for good, and
//                                                  Lead reports "<Source> adapter broken: <reason>
//                                                  (screenshot: <data/ path> | not captured)"
// W4a implements the real checker in src/adapters/** (source-specific required fields, salary and
// date plausibility, LinkedIn's page-view limit, layout-change detection); production wiring takes
// it from there. A checker that throws is logged and the output accepted, so an adapter bug never
// blocks a scan.
import type { Engine as EngineName, ResearchScanOutput } from "@bs-job-agents/shared";

export interface ScanCheckInput {
  taskId: number;
  runId: number | null;
  attempt: number;
  /** The engine the scan ran on. */
  engine: EngineName;
  /** The task's source (topcv | itviec | linkedin | career_site …), from its input. */
  source: string;
  /** The research.scan task input (source, criteria, maxPageViews, …). */
  input: unknown;
  /** The validated output (schema + self-check passed). */
  output: ResearchScanOutput;
  /** Screenshots captured in this attempt, data/-relative, oldest first (empty when none: Codex, or no capture). */
  screenshots: string[];
  /**
   * W4a handoff: each page a navigate call opened in this spawn, with the time the bot asked for it
   * (the runner's clock), in order. Absent when the runner reported none (Codex, or no navigate).
   */
  pageVisits?: readonly { url: string; at: string }[];
  /** API research (AD-6): "api" when the orchestrator fetched it (no Chrome: no page views, no screenshots). */
  via?: "api";
}

export type ScanCheckResult =
  | { ok: true }
  | {
      ok: false;
      /** true: the adapter/layout is broken (no retry); false: this output is implausible (retry). */
      adapterBroken: boolean;
      /** Plain words for Ba, e.g. "no job cards on the results page". */
      reason: string;
      /** data/-relative screenshot that shows the problem; null/absent = "not captured". */
      screenshot?: string | null;
    };

export interface ScanOutputChecker {
  check(input: ScanCheckInput): ScanCheckResult | Promise<ScanCheckResult>;
}

/** The engine's default: every output that passed the schema and self-check is accepted. */
export const acceptAllScanOutputChecker: ScanOutputChecker = { check: () => ({ ok: true }) };

const BOARD_SOURCES: ReadonlySet<string> = new Set(["topcv", "itviec", "linkedin", "career_site"]);

/**
 * A basic checker W4a can build on: on a job board every job must come from that source and have
 * its posting URL. An empty list is a valid result (UC-03 d).
 */
export const basicScanOutputChecker: ScanOutputChecker = {
  check({ source, output }) {
    if (!BOARD_SOURCES.has(source)) return { ok: true };
    for (const [i, job] of output.jobs.entries()) {
      const label = `job ${i + 1} (${job.company})`;
      if (job.source !== source) return { ok: false, adapterBroken: false, reason: `${label} says it comes from ${job.source}, not ${source}` };
      if (job.url === null) return { ok: false, adapterBroken: false, reason: `${label} has no posting URL` };
    }
    return { ok: true };
  },
};

/** The task error for a broken adapter (notices.ts reports it as UC-03 b). */
export function adapterBrokenError(reason: string, screenshot: string | null | undefined): string {
  return `adapter broken: ${reason} (screenshot: ${screenshot ?? "not captured"})`;
}

/** The task error for an implausible output (retried). */
export function scanRejectedError(reason: string): string {
  return `scan output rejected: ${reason}`;
}
