import type { JobCandidate } from "@bs-job-agents/shared";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Conn } from "../client.js";
import { canonicalizeUrl, jobDedupeHash } from "../dedupe.js";
import { ACTIVE_RUN_STATUSES, type JobStatus, type SkipReason } from "../enums.js";
import { InvalidTransitionError, NotFoundError } from "../errors.js";
import { jobs, runs, steps, tasks } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { Job } from "../types.js";
import { ensureCompany } from "./companies.js";

/**
 * The shared `JobCandidate` (UC-03) fields the data layer stores. `url` is null only
 * for an uploaded JD whose posting was not found (§7.3b); such a job dedupes by hash.
 */
export type JobCandidateInput = Pick<JobCandidate, "source" | "url" | "title" | "company" | "language"> &
  Partial<Pick<JobCandidate, "companyWebsite" | "location" | "workMode" | "salaryText" | "postedAt" | "jdText">>;

export type DuplicateMatch = "canonical_url" | "dedupe_hash";

export interface UpsertJobResult {
  job: Job;
  created: boolean;
  matchedBy?: DuplicateMatch;
}

export function dedupeKeys(c: Pick<JobCandidateInput, "url" | "company" | "title" | "location">) {
  return { canonicalUrl: c.url ? canonicalizeUrl(c.url) : null, dedupeHash: jobDedupeHash(c) };
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
    .where(or(canonicalUrl ? eq(jobs.canonicalUrl, canonicalUrl) : undefined, eq(jobs.dedupeHash, dedupeHash)))
    .all();
  const byUrl = canonicalUrl ? rows.find((r) => r.canonicalUrl === canonicalUrl) : undefined;
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
    const company = ensureCompany(tx, { name: c.company, website: c.companyWebsite ?? null });
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
        workMode: c.workMode ?? null,
        salaryText: c.salaryText ?? null,
        postedAt: c.postedAt ?? null,
        language: c.language,
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
  /**
   * Jobs to score: newly inserted, jobs a failed or cancelled run left `new` (PM S3), and
   * previously skipped ones with `includeSkipped`.
   */
  fresh: Job[];
  duplicates: { candidate: JobCandidateInput; job: Job; matchedBy: DuplicateMatch }[];
  /** PM2 S11 (additive): the job of each candidate, in input order (fresh or duplicate). */
  jobs: Job[];
}

/** Leading job id of a branch key: `42` or `42:vi` → 42 (0 when not numeric). */
const branchJobId = sql<number>`CAST(${steps.branchKey} AS INTEGER)`;
const inputJobId = sql<number>`CAST(json_extract(${tasks.input}, '$.jobId') AS INTEGER)`;

/**
 * Jobs an active run (running, waiting or paused) is working on: a task input names the job
 * (`jobId`), or a per-job branch step is keyed by it. `excludeRunId` leaves one run out, e.g. a
 * run re-running its own dedupe step (UC-23).
 */
export function jobIdsInActiveRuns(db: Conn, opts: { excludeRunId?: number } = {}): Set<number> {
  const activeRun = and(
    inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
    opts.excludeRunId !== undefined ? ne(runs.id, opts.excludeRunId) : undefined,
  );
  const fromTasks = db
    .select({ id: inputJobId })
    .from(tasks)
    .innerJoin(runs, eq(runs.id, tasks.runId))
    .where(and(activeRun, sql`json_extract(${tasks.input}, '$.jobId') IS NOT NULL`))
    .all();
  const fromSteps = db
    .select({ id: branchJobId })
    .from(steps)
    .innerJoin(runs, eq(runs.id, steps.runId))
    .where(and(activeRun, ne(steps.branchKey, "")))
    .all();
  return new Set([...fromTasks, ...fromSteps].map((r) => Number(r.id)).filter((id) => Number.isInteger(id) && id > 0));
}

/**
 * The `filter dedupe` step (§7.2 step 3): stores new candidates and drops
 * duplicates, including duplicates within the same batch. A job seen before but
 * skipped stays excluded unless `includeSkipped` ("show skipped", UC-04b).
 *
 * PM S3: a job still `new` (never scored) that no active run is working on was left by a run
 * that failed or was cancelled; it is offered again rather than dropped forever. Ownership is
 * `ownedJobIds` when given, else jobIdsInActiveRuns (minus `excludeRunId`).
 */
export function dedupeCandidates(
  db: Conn,
  candidates: readonly JobCandidateInput[],
  opts: ClockOpts & { includeSkipped?: boolean; excludeRunId?: number; ownedJobIds?: ReadonlySet<number> } = {},
): DedupeResult {
  return db.transaction((tx) => {
    const result: DedupeResult = { fresh: [], duplicates: [], jobs: [] };
    const owned = opts.ownedJobIds ?? jobIdsInActiveRuns(tx, { excludeRunId: opts.excludeRunId });
    const seen = new Set<number>();
    for (const candidate of candidates) {
      const r = upsertJobCandidate(tx, candidate, opts);
      const resurfaced =
        !r.created &&
        !seen.has(r.job.id) &&
        ((opts.includeSkipped === true && r.job.status === "skipped") || (r.job.status === "new" && !owned.has(r.job.id)));
      if (r.created || resurfaced) result.fresh.push(r.job);
      else result.duplicates.push({ candidate, job: r.job, matchedBy: r.matchedBy ?? "canonical_url" });
      result.jobs.push(r.job);
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

/**
 * UC-07 b / §10.2 rule 4: QA suspected prompt injection in this job's JD or page.
 * Apply stays blocked until Ba confirms (clearJobInjection). Idempotent; a new flag
 * after Ba confirmed keeps the confirmation (same posting).
 */
export function flagJobInjection(db: Conn, id: number): Job {
  return updateJob(db, id, { injectionFlagged: true });
}

/** UC-07 b: Ba confirmed a flagged job is safe to apply to. */
export function clearJobInjection(db: Conn, id: number, opts?: ClockOpts): Job {
  const row = db
    .update(jobs)
    .set({ injectionClearedAt: nowIso(opts) })
    .where(and(eq(jobs.id, id), eq(jobs.injectionFlagged, true)))
    .returning()
    .get();
  if (row) return row;
  const job = getJob(db, id);
  if (!job) throw new NotFoundError("job", id);
  throw new InvalidTransitionError("job injection flag", "not flagged", "cleared");
}
