// Review queue (§11 Review queue, UC-07/08/09/10).
import { z } from "zod";
import { CvLanguageSchema, DomainSchema, IdSchema, IsoDateTimeSchema } from "../common/primitives.js";
import { FactRequestSchema } from "../bots/cv.js";
import { CvVersionSchema, QaReviewRecordSchema } from "../domain/cv-version.js";
import { CompanySchema, JobSchema, SkipDecisionSchema } from "../domain/job.js";
import { FileRefSchema } from "./common.js";

export const ReviewCardFlagsSchema = z.object({
  qaPassed: z.boolean(),
  /** QA not passed after 3 rounds (UC-07 a). */
  escalated: z.boolean(),
  /** factRequests or questions need Ba (UC-09 a). */
  needsInput: z.boolean(),
  /** Apply disabled until Ba confirms (UC-07 b). */
  injectionFlagged: z.boolean(),
  /** Master data changed since the CV was built (UC-20). */
  masterChanged: z.boolean(),
  /** Uploaded JD with no apply link: Approve only produces the PDF (§7.3b). */
  noApplyLink: z.boolean(),
  /** Company profile marked low_confidence (UC-05 b). */
  lowConfidenceCompany: z.boolean(),
});

export const ReviewCvOptionSchema = z.object({
  cvVersion: CvVersionSchema,
  /** All QA rounds for this language, oldest first. */
  qaRounds: z.array(QaReviewRecordSchema),
  pdf: FileRefSchema.nullable(),
});

export const ReviewCardSchema = z.object({
  job: JobSchema,
  company: CompanySchema.nullable(),
  runId: IdSchema.nullable(),
  /** One per language: EN, or VI + EN for a Vietnamese JD (§6.3). */
  cvOptions: z.array(ReviewCvOptionSchema).min(1),
  defaultLanguage: CvLanguageSchema,
  introText: z.string().nullable(),
  factRequests: z.array(FactRequestSchema),
  flags: ReviewCardFlagsSchema,
  readyAt: IsoDateTimeSchema,
});
export type ReviewCard = z.infer<typeof ReviewCardSchema>;

export const ReviewQueueResponseSchema = z.object({ cards: z.array(ReviewCardSchema) });

/** UC-08: Approve & submit (covers ticking the consent box). */
export const ApproveRequestSchema = z.object({
  /** The chosen language's CV version (default VI for a VI JD). */
  cvVersionId: IdSchema,
  /** Edited intro/cover text, or null to use the generated one (UC-08 b). */
  introText: z.string().nullable(),
});
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>;

export const ApproveResponseSchema = z.object({
  applicationId: IdSchema,
  /** Null when there is nothing to submit (no apply link, §7.3b). */
  taskId: IdSchema.nullable(),
  approval: z.object({ expiresAt: IsoDateTimeSchema, allowedDomains: z.array(DomainSchema) }).nullable(),
});
export type ApproveResponse = z.infer<typeof ApproveResponseSchema>;

/** UC-09 */
export const RequestChangesRequestSchema = z.object({ comment: z.string().trim().min(1) });
export type RequestChangesRequest = z.infer<typeof RequestChangesRequestSchema>;

/** UC-10 */
export const SkipRequestSchema = SkipDecisionSchema;
export type SkipRequest = z.infer<typeof SkipRequestSchema>;

/** UC-07 b: Ba confirms a flagged job is safe to apply to. */
export const ConfirmInjectionRequestSchema = z.object({ confirmed: z.literal(true) });
