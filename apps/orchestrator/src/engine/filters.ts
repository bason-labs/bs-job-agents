// `filter` steps (§7.1): pure code, no model call.
// - dedupe after a scan (§7.2 step 3, UC-04): store new candidates, drop known jobs (canonical URL
//   or company+title+location), offer again jobs a failed run left `new` (PM S3).
// - dedupe after a pasted link or file (§7.3, UC-14 a): the job was asked for explicitly, so only
//   "already applied" stops it, unless Ba said "apply again".
// - top (§7.2 step 5, UC-04): fit ≥ threshold, best first, take maxJobs; the rest are below_threshold
//   and the best 3 below it are kept for "no strong matches" (UC-04 a).
import { LIMITS, type JobCandidate, type ResearchScanOutput } from "@bs-job-agents/shared";
import { dedupeCandidates, getApplicationByJob, getCompany, getJob, setJobStatus, type Conn, type Job } from "../db/index.js";
import type { RunCtx } from "./context.js";
import { invalidInput } from "./errors.js";
import type { FilterStepOutput, JobRef, JoinStepOutput } from "./state.js";

export function jobRef(conn: Conn, job: Job): JobRef {
  return { jobId: job.id, title: job.title, company: getCompany(conn, job.companyId)?.name ?? "" };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function dedupeFilter(conn: Conn, ctx: RunCtx, from: JoinStepOutput, options: Record<string, unknown>, now: Date, passKey = ""): FilterStepOutput {
  if (from.taskKey === "research.fit") {
    const applyAgain = options.applyAgain === true;
    const items: JobRef[] = [];
    const alreadyApplied: { jobId: number; applicationId: number; status: string }[] = [];
    for (const r of from.results) {
      const job = r.jobId === undefined ? undefined : getJob(conn, r.jobId);
      if (!job) continue;
      const existing = getApplicationByJob(conn, job.id);
      if (existing && !applyAgain) {
        alreadyApplied.push({ jobId: job.id, applicationId: existing.id, status: existing.status });
        continue;
      }
      setJobStatus(conn, job.id, "selected");
      items.push(jobRef(conn, job));
    }
    return { items, alreadyApplied };
  }
  const candidates = from.results.flatMap((r) => (r.output as Partial<ResearchScanOutput> | null)?.jobs ?? []) as JobCandidate[];
  // UC-04 b: a job Ba skipped stays excluded unless the run says "show skipped".
  const includeSkipped = ctx.params.showSkipped === true;
  // The run's own jobs count as taken in a follow-up pass (PM2 M5): the main pass may still be
  // scoring one the late source found too. Only the main pass leaves its own run out (UC-23 re-run).
  const r = dedupeCandidates(conn, candidates, { now, ...(passKey === "" ? { excludeRunId: ctx.run.id } : {}), includeSkipped });
  return { items: r.fresh.map((job) => jobRef(conn, job)), candidates: candidates.length, duplicates: r.duplicates.length };
}

export function topFilter(conn: Conn, ctx: RunCtx, from: JoinStepOutput, options: Record<string, unknown>): FilterStepOutput {
  const threshold = num(options.threshold) ?? ctx.profile?.fitThreshold ?? LIMITS.fitThresholdDefault;
  const take = num(options.take) ?? ctx.profile?.maxJobs ?? LIMITS.maxJobsDefault;
  const scored = from.results
    .map((r) => (r.jobId === undefined ? undefined : getJob(conn, r.jobId)))
    .filter((j): j is Job => j !== undefined && j.fitScore !== null)
    .sort((a, b) => b.fitScore! - a.fitScore! || a.id - b.id);
  const passing = scored.filter((j) => j.fitScore! >= threshold);
  const selected = passing.slice(0, take);
  for (const job of scored) setJobStatus(conn, job.id, selected.includes(job) ? "selected" : "below_threshold");
  const belowThreshold = scored
    .filter((j) => !passing.includes(j))
    .slice(0, 3)
    .map((j) => ({ ...jobRef(conn, j), fitScore: j.fitScore, gaps: j.gaps ?? [] }));
  return { items: selected.map((j) => jobRef(conn, j)), threshold, take, belowThreshold };
}

export function runFilter(conn: Conn, ctx: RunCtx, fn: string, from: unknown, options: Record<string, unknown>, now: Date, passKey = ""): FilterStepOutput {
  const join = from as JoinStepOutput | null;
  if (!join || !Array.isArray(join.results)) throw invalidInput(`filter ${fn} needs a join step's output`);
  switch (fn) {
    case "dedupe":
      return dedupeFilter(conn, ctx, join, options, now, passKey);
    case "top":
      return topFilter(conn, ctx, join, options);
    default:
      throw invalidInput(`unknown filter function "${fn}"`);
  }
}
