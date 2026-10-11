// PM2 S11 (§10.2 rule 4): Apply and Research read untrusted pages and may report an injection
// attempt (`injectionSuspected` + `injectionNote` in ApplyOutput and ResearchScanOutput).
// - Apply: the application needs a check (never recorded as submitted), a paused Apply stops, a
//   safety event is logged and the job is flagged.
// - Research: a safety event is logged when the task settles, and the jobs its output named are
//   flagged when they are stored (dedupe), so Apply stays disabled for them until Ba confirms
//   (UC-07 b, the same path as QA's flag).
import { taskKey, type JobCandidate } from "@bs-job-agents/shared";
import { flagJobInjection, getStepByKey, type Conn, type Job } from "../db/index.js";
import type { RunCtx } from "./context.js";
import type { JoinStepOutput } from "./state.js";

/** Task kinds whose output may report an injection attempt. */
export const INJECTION_REPORTING_TASKS: readonly string[] = ["apply.submit", "research.scan", "research.single", "research.file"];

/** The bot's report, or null when it suspects nothing (or its kind cannot report). */
export function reportedInjection(key: string, output: unknown): { note: string | null } | null {
  if (!INJECTION_REPORTING_TASKS.includes(key)) return null;
  const o = output as { injectionSuspected?: unknown; injectionNote?: unknown } | null;
  if (o?.injectionSuspected !== true) return null;
  return { note: typeof o.injectionNote === "string" && o.injectionNote.trim() !== "" ? o.injectionNote : null };
}

export const injectionDetail = (note: string | null): string => note ?? "the page tried to instruct the bot";

/** Flag each job once (idempotent in the repository). */
export function flagJobs(conn: Conn, jobs: readonly Pick<Job, "id">[]): void {
  for (const id of new Set(jobs.map((j) => j.id))) flagJobInjection(conn, id);
}

/**
 * job-scan dedupe: the candidates of each scan output that reported an injection, as indexes into
 * the flattened candidate list (the order dedupeCandidates returns its `jobs` in).
 */
export function suspiciousCandidateIndexes(from: JoinStepOutput): Set<number> {
  const out = new Set<number>();
  let i = 0;
  for (const r of from.results) {
    const jobs = ((r.output as { jobs?: JobCandidate[] } | null)?.jobs ?? []) as JobCandidate[];
    const flagged = reportedInjection("research.scan", r.output) !== null;
    for (let k = 0; k < jobs.length; k++, i++) if (flagged) out.add(i);
  }
  return out;
}

/** apply-to-link / apply-to-file: whether the run's single or file read reported an injection. */
export function runReadReportedInjection(conn: Conn, ctx: RunCtx, passKey = ""): boolean {
  for (const s of ctx.def.steps) {
    if (s.type !== "task") continue;
    const key = taskKey(s.task.bot, s.task.kind);
    if (key !== "research.single" && key !== "research.file" && key !== "research.scan") continue;
    if (reportedInjection(key, getStepByKey(conn, ctx.run.id, s.key, passKey)?.output)) return true;
  }
  return false;
}
