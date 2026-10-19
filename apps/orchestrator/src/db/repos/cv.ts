import {
  LIMITS,
  qaPassed,
  type FactRequest,
  type QaFix,
  type QaHardFail,
  type QaScores,
  type TailoredCv,
} from "@bs-job-agents/shared";
import { and, asc, desc, eq, max } from "drizzle-orm";
import type { Conn } from "../client.js";
import type { CvLanguage } from "../enums.js";
import { NotFoundError } from "../errors.js";
import { cvVersions, jobs, qaReviews } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { CvVersion, QaReview } from "../types.js";

/** A CV bot draft (shared `CvDraft`) plus what the orchestrator adds after export (§6.2). */
export interface CreateCvVersionInput {
  jobId: number;
  language: CvLanguage;
  /** QA gate round; defaults to the next round for this job + language. */
  round?: number;
  tailored: TailoredCv;
  /** Drafts frame `<COMPANY>_<ROLE>_<LANG>_v<n>`; the PDF is data/pdf/<name>.pdf. */
  figmaFrameName: string;
  figmaFrameUrl: string | null;
  pdfPath?: string | null;
  /** SHA-256 of the exported PDF; Apply's upload must match it (§9.1). */
  pdfSha256?: string | null;
  changeNotes?: string[];
  factRequests?: FactRequest[];
  masterVersion: number;
  promptVersion: number;
}

export function createCvVersion(db: Conn, input: CreateCvVersionInput, opts?: ClockOpts): CvVersion {
  const round =
    input.round ??
    (db
      .select({ r: max(cvVersions.round) })
      .from(cvVersions)
      .where(and(eq(cvVersions.jobId, input.jobId), eq(cvVersions.language, input.language)))
      .get()?.r ?? 0) + 1;
  return db
    .insert(cvVersions)
    .values({
      jobId: input.jobId,
      language: input.language,
      round,
      tailored: input.tailored,
      figmaFrameName: input.figmaFrameName,
      figmaFrameUrl: input.figmaFrameUrl,
      pdfPath: input.pdfPath ?? null,
      pdfSha256: input.pdfSha256 ?? null,
      changeNotes: input.changeNotes ?? [],
      factRequests: input.factRequests ?? [],
      masterVersion: input.masterVersion,
      promptVersion: input.promptVersion,
      createdAt: nowIso(opts),
    })
    .returning()
    .get();
}

export function getCvVersion(db: Conn, id: number): CvVersion | undefined {
  return db.select().from(cvVersions).where(eq(cvVersions.id, id)).get();
}

/** The CV version whose exported PDF is at this path (data/-relative), if any. */
export function findCvVersionByPdfPath(db: Conn, pdfPath: string): CvVersion | undefined {
  return db.select().from(cvVersions).where(eq(cvVersions.pdfPath, pdfPath)).get();
}

export function listCvVersions(db: Conn, jobId: number): CvVersion[] {
  return db.select().from(cvVersions).where(eq(cvVersions.jobId, jobId)).orderBy(asc(cvVersions.id)).all();
}

export function latestCvVersion(db: Conn, jobId: number, language: CvLanguage): CvVersion | undefined {
  return db
    .select()
    .from(cvVersions)
    .where(and(eq(cvVersions.jobId, jobId), eq(cvVersions.language, language)))
    .orderBy(desc(cvVersions.round), desc(cvVersions.id))
    .limit(1)
    .get();
}

/** A QA bot review (shared `QaReview`) of one CV version. */
export interface CreateQaReviewInput {
  cvVersionId: number;
  total: number;
  scores: QaScores;
  hardFails: QaHardFail[];
  fixes: QaFix[];
  injectionSuspected: boolean;
  /** Defaults to the pass rule (§5.2 QA): total ≥ 80 and no hard fails. */
  passed?: boolean;
}

/** §5.2 QA pass rule threshold (shared LIMITS). */
export const QA_PASS_TOTAL = LIMITS.qaPassScore;

/**
 * Store a QA review. When QA suspects prompt injection, the job is flagged in the same
 * transaction, so Apply is blocked until Ba confirms (UC-07 b, §10.2 rule 4).
 */
export function createQaReview(db: Conn, input: CreateQaReviewInput, opts?: ClockOpts): QaReview {
  return db.transaction((tx) => {
    const cv = getCvVersion(tx, input.cvVersionId);
    if (!cv) throw new NotFoundError("cv version", input.cvVersionId);
    const passed = input.passed ?? qaPassed(input);
    const review = tx
      .insert(qaReviews)
      .values({ ...input, passed, createdAt: nowIso(opts) })
      .returning()
      .get();
    if (input.injectionSuspected) {
      tx.update(jobs).set({ injectionFlagged: true }).where(eq(jobs.id, cv.jobId)).run();
    }
    return review;
  });
}

export function listQaReviews(db: Conn, cvVersionId: number): QaReview[] {
  return db.select().from(qaReviews).where(eq(qaReviews.cvVersionId, cvVersionId)).orderBy(asc(qaReviews.id)).all();
}

export function latestQaReview(db: Conn, cvVersionId: number): QaReview | undefined {
  return db
    .select()
    .from(qaReviews)
    .where(eq(qaReviews.cvVersionId, cvVersionId))
    .orderBy(desc(qaReviews.id))
    .limit(1)
    .get();
}

export function getQaReview(db: Conn, id: number): QaReview | undefined {
  return db.select().from(qaReviews).where(eq(qaReviews.id, id)).get();
}
