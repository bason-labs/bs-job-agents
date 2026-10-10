import { and, asc, desc, eq, max } from "drizzle-orm";
import type { Conn } from "../client.js";
import type { CvLanguage } from "../enums.js";
import { cvVersions, qaReviews, type JsonObject } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { CvVersion, QaReview } from "../types.js";

export interface CreateCvVersionInput {
  jobId: number;
  language: CvLanguage;
  /** QA gate round; defaults to the next round for this job + language. */
  round?: number;
  tailored?: JsonObject | null;
  figmaFrameUrl?: string | null;
  pdfPath?: string | null;
  pdfSha256?: string | null;
  masterVersion?: number | null;
  promptVersion?: number | null;
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
      tailored: input.tailored ?? null,
      figmaFrameUrl: input.figmaFrameUrl ?? null,
      pdfPath: input.pdfPath ?? null,
      pdfSha256: input.pdfSha256 ?? null,
      masterVersion: input.masterVersion ?? null,
      promptVersion: input.promptVersion ?? null,
      createdAt: nowIso(opts),
    })
    .returning()
    .get();
}

export function getCvVersion(db: Conn, id: number): CvVersion | undefined {
  return db.select().from(cvVersions).where(eq(cvVersions.id, id)).get();
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

export interface CreateQaReviewInput {
  cvVersionId: number;
  total: number;
  scores: Record<string, number>;
  hardFails: unknown[];
  fixes: unknown[];
  injectionSuspected: boolean;
  /** Defaults to the pass rule (§5.2 QA): total ≥ 80 and no hard fails. */
  passed?: boolean;
}

export const QA_PASS_TOTAL = 80;

export function createQaReview(db: Conn, input: CreateQaReviewInput, opts?: ClockOpts): QaReview {
  const passed = input.passed ?? (input.total >= QA_PASS_TOTAL && input.hardFails.length === 0);
  return db
    .insert(qaReviews)
    .values({ ...input, passed, createdAt: nowIso(opts) })
    .returning()
    .get();
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
