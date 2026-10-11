// §6.1: facts CV asked Ba for while tailoring (CvOutput.factRequests), shown on the Master CV screen
// until Ba adds the fact or answers "No, I don't". Only the newest CV version of a job counts (a
// later round supersedes the earlier one's questions), and only while the job is still open.
import type { FactRequestItem } from "@bs-job-agents/shared";
import { asc } from "drizzle-orm";
import { getCompany, getJob, schema, type Db } from "../../db/index.js";
import { readApiState } from "../state.js";

const CLOSED_JOB_STATUSES = new Set(["applied", "skipped", "below_threshold"]);

export function openFactRequests(db: Db, dataDir: string): FactRequestItem[] {
  const dismissed = new Set(readApiState(dataDir).dismissedFactRequests);
  const newest = new Map<number, typeof schema.cvVersions.$inferSelect>();
  for (const v of db.select().from(schema.cvVersions).orderBy(asc(schema.cvVersions.id)).all()) newest.set(v.jobId, v);
  const out: FactRequestItem[] = [];
  for (const v of newest.values()) {
    const job = getJob(db, v.jobId);
    if (!job || CLOSED_JOB_STATUSES.has(job.status)) continue;
    const company = getCompany(db, job.companyId)?.name ?? "";
    v.factRequests.forEach((r, i) => {
      const id = `${v.id}-${i}`;
      if (dismissed.has(id)) return;
      out.push({ id, jobId: String(job.id), company, topic: r.topic, question: r.question, reason: r.reason });
    });
  }
  return out;
}
