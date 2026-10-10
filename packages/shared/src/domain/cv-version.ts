// CV versions and QA reviews (§9 `cv_versions`, `qa_reviews`).
import { z } from "zod";
import { CvLanguageSchema, IdSchema, IsoDateTimeSchema, LIMITS, Sha256Schema, UrlSchema } from "../common/primitives.js";
import { FactRequestSchema, TailoredCvSchema } from "../bots/cv.js";
import { QaFixSchema, QaHardFailSchema, QaScoresSchema } from "../bots/qa.js";

export const CvVersionSchema = z.object({
  id: IdSchema,
  jobId: IdSchema,
  language: CvLanguageSchema,
  /** QA gate round, 1..3; a request-changes round continues the count per job. */
  round: z.number().int().positive(),
  tailored: TailoredCvSchema,
  figmaFrameName: z.string().min(1),
  figmaFrameUrl: UrlSchema.nullable(),
  pdfPath: z.string().nullable(),
  /** SHA-256 of the exported PDF; Apply's upload must match it (§9.1). */
  pdfSha256: Sha256Schema.nullable(),
  changeNotes: z.array(z.string()),
  factRequests: z.array(FactRequestSchema),
  masterVersion: z.number().int().positive(),
  promptVersion: z.number().int().positive(),
  createdAt: IsoDateTimeSchema,
});
export type CvVersion = z.infer<typeof CvVersionSchema>;

export const QaReviewRecordSchema = z.object({
  id: IdSchema,
  cvVersionId: IdSchema,
  total: z.number().int().min(0).max(100),
  scores: QaScoresSchema,
  hardFails: z.array(QaHardFailSchema),
  fixes: z.array(QaFixSchema),
  injectionSuspected: z.boolean(),
  passed: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type QaReviewRecord = z.infer<typeof QaReviewRecordSchema>;

export const QA_MAX_ROUNDS = LIMITS.qaMaxRounds;
