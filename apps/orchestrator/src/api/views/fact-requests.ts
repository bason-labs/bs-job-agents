// §6.1: facts CV asked Ba for while tailoring (CvOutput.factRequests), shown on the Master CV screen
// until Ba adds the fact or answers "No, I don't". Only the newest CV version of a job counts (a
// later round supersedes the earlier one's questions), and only while the job is still open.
// CV guidance (§5.8): requests a guidance rule raised are tied to one fact and one field. They are
// asked once across all jobs (keyed by rule, fact and field, so answering or dismissing one closes
// it for every job), come from whichever round went to review, and close by themselves when the
// master CV now has the detail (the fact's months, the contact's phone).
import { datesHaveMonths, type CvFactRequest, type FactRequestItem, type MasterCv } from "@bs-job-agents/shared";
import { asc } from "drizzle-orm";
import { getCompany, getJob, schema, type Db } from "../../db/index.js";
import { readMasterCv } from "../master-cv.js";
import { readApiState } from "../state.js";

const CLOSED_JOB_STATUSES = new Set(["applied", "skipped", "below_threshold"]);

/** The one id of a guidance request across jobs and rounds. */
export const guidanceRequestId = (r: Pick<CvFactRequest, "ruleId" | "factId" | "field">): string => `g-${r.ruleId}-${r.factId}-${r.field}`;

/** The master CV now has what the request asked for. */
function answeredByMaster(r: CvFactRequest, cv: MasterCv | null): boolean {
  if (!cv) return false;
  if (r.field === "contact.phone") return !!cv.contact.phone;
  if (r.field === "dates") return datesHaveMonths(cv.facts.find((f) => f.id === r.factId)?.dates ?? null);
  return false;
}

export function openFactRequests(db: Db, dataDir: string): FactRequestItem[] {
  const dismissed = new Set(readApiState(dataDir).dismissedFactRequests);
  const read = readMasterCv(dataDir);
  const master = read.kind === "ok" ? read.cv : null;
  const versions = db.select().from(schema.cvVersions).orderBy(asc(schema.cvVersions.id)).all();
  const newest = new Map<number, (typeof versions)[number]>();
  for (const v of versions) newest.set(v.jobId, v);
  const out: FactRequestItem[] = [];
  const openJob = (jobId: number) => {
    const job = getJob(db, jobId);
    return job && !CLOSED_JOB_STATUSES.has(job.status) ? job : null;
  };
  for (const v of newest.values()) {
    const job = openJob(v.jobId);
    if (!job) continue;
    const company = getCompany(db, job.companyId)?.name ?? "";
    v.factRequests.forEach((r, i) => {
      if (r.origin === "guidance") return;
      const id = `${v.id}-${i}`;
      if (dismissed.has(id)) return;
      out.push({ id, jobId: String(job.id), company, topic: r.topic, question: r.question, reason: r.reason });
    });
  }
  const guidance = new Map<string, FactRequestItem>();
  for (const v of versions) {
    for (const r of v.factRequests) {
      if (r.origin !== "guidance" || !r.ruleId || !r.factId || !r.field) continue;
      const job = openJob(v.jobId);
      if (!job) continue;
      const id = guidanceRequestId(r);
      if (dismissed.has(id) || answeredByMaster(r, master)) continue;
      const seen = guidance.get(id);
      if (seen) {
        if (seen.jobId !== String(job.id) && !seen.alsoJobIds!.includes(String(job.id))) seen.alsoJobIds!.push(String(job.id));
        continue;
      }
      guidance.set(id, {
        id,
        jobId: String(job.id),
        company: getCompany(db, job.companyId)?.name ?? "",
        topic: r.topic,
        question: r.question,
        reason: r.reason,
        origin: "guidance",
        ruleId: r.ruleId,
        ruleLabel: r.topic,
        factId: r.factId,
        field: r.field,
        alsoJobIds: [],
      });
    }
  }
  return [...out, ...guidance.values()];
}
