// PM2 S16 (UC-05): the company step of a per-job branch.
// - A step Ba re-runs himself is marked, so the company is researched again instead of being read
//   from the 30-day cache (a new branch still uses the cache, UC-05 a).
// - A company task that failed for good (its 2 attempts) no longer fails the branch: the step is
//   done with `company: null`, CV tailors without a profile, and the review card says so.
import { taskKey, type WorkflowDefinition } from "@bs-job-agents/shared";
import { getStepByKey, type Conn } from "../db/index.js";

/** A pending task step's output when Ba re-ran it himself. */
export const RERUN_MARK = { rerun: true } as const;

export function isRerunMarked(output: unknown): boolean {
  return (output as { rerun?: unknown } | null)?.rerun === true;
}

export const COMPANY_TASK_KEY = "research.company";

/** The company step's output when its task failed for good. */
export interface CompanyStepFailed {
  company: null;
  failed: true;
  error: string;
}

export const COMPANY_FAILED_PREVIEW = "company research failed · continuing without it";

export function companyFailedOutput(error: string): CompanyStepFailed {
  return { company: null, failed: true, error };
}

/** Whether a branch's company research failed for good (its card is flagged). */
export function companyMissing(conn: Conn, def: WorkflowDefinition, runId: number, branch: string | undefined, jobId: number): boolean {
  for (const s of def.steps) {
    if (s.type !== "task" || taskKey(s.task.bot, s.task.kind) !== COMPANY_TASK_KEY || s.branch !== branch) continue;
    const out = getStepByKey(conn, runId, s.key, String(jobId))?.output as Partial<CompanyStepFailed> | null | undefined;
    if (out?.failed === true) return true;
  }
  return false;
}
