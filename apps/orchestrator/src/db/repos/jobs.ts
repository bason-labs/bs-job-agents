import { desc, eq, inArray, or } from "drizzle-orm";
import type { Conn } from "../client.js";
import { canonicalizeUrl, jobDedupeHash } from "../dedupe.js";
import type { JobStatus, SkipReason } from "../enums.js";
import { NotFoundError } from "../errors.js";
import { jobs } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { Job } from "../types.js";
import { ensureCompany } from "./companies.js";

/** Fields of a `JobCandidate` (UC-03) the data layer stores. */
export interface JobCandidateInput {
  source: string;
  url: string;
  title: string;
  company: string;
  location?: string | null;
  salaryText?: string | null;
  postedAt?: string | null;
  language?: string | null;
  jdText?: string | null;
}

export type DuplicateMatch = "canonical_url" | "dedupe_hash";

export interface UpsertJobResult {
  job: Job;
  created: boolean;
  matchedBy?: DuplicateMatch;
}

export function dedupeKeys(c: Pick<JobCandidateInput, "url" | "company" | "title" | "location">) {
  return { canonicalUrl: canonicalizeUrl(c.url), dedupeHash: jobDedupeHash(c) };
}

/** Existing job matching the candidate's canonical URL or company+title+location hash. */
export function findDuplicateJob(
  db: Conn,
  c: Pick<JobCandidateInput, "url" | "company" | "title" | "location">,
): { job: Job; matchedBy: DuplicateMatch } | undefined {
  const { canonicalUrl, dedupeHash } = dedupeKeys(c);
  const rows = db
    .select()
    .from(jobs)
    .where(or(eq(jobs.canonicalUrl, canonicalUrl), eq(jobs.dedupeHash, dedupeHash)))
    .all();
  const byUrl = rows.find((r) => r.canonicalUrl === canonicalUrl);
  if (byUrl) return { job: byUrl, matchedBy: "canonical_url" };
  if (rows[0]) return { job: rows[0], matchedBy: "dedupe_hash" };
  return undefined;
}

/**
 * Insert a scanned candidate as a `new` job, unless it duplicates an existing
 * job (UC-04 step 1), in which case the existing row is returned untouched.
 * Imported applications have job rows too, so this also dedupes against them.
 */
export function upsertJobCandidate(db: Conn, c: JobCandidateInput, opts?: ClockOpts): UpsertJobResult {
  return db.transaction((tx) => {
    const dup = findDuplicateJob(tx, c);
    if (dup) return { job: dup.job, created: false, matchedBy: dup.matchedBy };
    const company = ensureCompany(tx, { name: c.company });
    const { canonicalUrl, dedupeHash } = dedupeKeys(c);
    const job = tx
      .insert(jobs)
      .values({
        source: c.source,
        url: c.url,
        canonicalUrl,
        dedupeHash,
        title: c.title,
        companyId: company.id,
        location: c.location ?? null,
        salaryText: c.salaryText ?? null,
        postedAt: c.postedAt ?? null,
        language: c.language ?? null,
        jdText: c.jdText ?? null,
        status: "new",
        firstSeenAt: nowIso(opts),
      })
      .returning()
      .get();
    return { job, created: true };
  });
}

export interface DedupeResult {
  /** Jobs to score: newly inserted (and previously skipped ones with `includeSkipped`). */
  fresh: Job[];
  duplicates: { candidate: JobCandidateInput; job: Job; matchedBy: DuplicateMatch }[];
}

/**
 * The `filter dedupe` step (§7.2 step 3): stores new candidates and drops
 * duplicates, including duplicates within the same batch. A job seen before but
 * skipped stays excluded unless `includeSkipped` ("show skipped", UC-04b).
 */
export function dedupeCandidates(
  db: Conn,
  candidates: readonly JobCandidateInput[],
  opts: ClockOpts & { includeSkipped?: boolean } = {},
): DedupeResult {
  return db.transaction((tx) => {
    const result: DedupeResult = { fresh: [], duplicates: [] };
    const seen = new Set<number>();
    for (const candidate of candidates) {
      const r = upsertJobCandidate(tx, candidate, opts);
      const resurfaced = !r.created && opts.includeSkipped && r.job.status === "skipped" && !seen.has(r.job.id);
      if (r.created || resurfaced) result.fresh.push(r.job);
      else result.duplicates.push({ candidate, job: r.job, matchedBy: r.matchedBy ?? "canonical_url" });
      seen.add(r.job.id);
    }
    return result;
  });
}

export function getJob(db: Conn, id: number): Job | undefined {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

/** UC-14a: look up a pasted link. */
export function findJobByUrl(db: Conn, url: string): Job | undefined {
  return db.select().from(jobs).where(eq(jobs.canonicalUrl, canonicalizeUrl(url))).get();
}

export function listJobs(db: Conn, filter: { status?: JobStatus | readonly JobStatus[]; limit?: number } = {}): Job[] {
  const statuses = filter.status === undefined ? undefined : ([] as JobStatus[]).concat(filter.status);
  const q = db
    .select()
    .from(jobs)
    .where(statuses ? inArray(jobs.status, statuses) : undefined)
    .orderBy(desc(jobs.firstSeenAt), desc(jobs.id));
  return filter.limit ? q.limit(filter.limit).all() : q.all();
}

function updateJob(db: Conn, id: number, set: Partial<typeof jobs.$inferInsert>): Job {
  const row = db.update(jobs).set(set).where(eq(jobs.id, id)).returning().get();
  if (!row) throw new NotFoundError("job", id);
  return row;
}

/** Store a `FitScore` (UC-04 step 2). */
export function setJobFit(db: Conn, id: number, fit: { score: number; reasons: string[]; gaps: string[] }): Job {
  return updateJob(db, id, { fitScore: fit.score, fitReasons: fit.reasons, gaps: fit.gaps });
}

export function setJobStatus(db: Conn, id: number, status: JobStatus): Job {
  return updateJob(db, id, status === "skipped" ? { status } : { status, skipReason: null, skipNote: null });
}

/** UC-10: skip with a reason (input for sub-project D). */
export function skipJob(db: Conn, id: number, input: { reason: SkipReason; note?: string | null }): Job {
  return updateJob(db, id, { status: "skipped", skipReason: input.reason, skipNote: input.note ?? null });
}
