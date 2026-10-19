// Review queue (§11 Review queue, UC-07/08/09/10).
import { z } from "zod";
import { CvLanguageSchema, DomainSchema, IdSchema, IsoDateTimeSchema } from "../common/primitives.js";
import { FactRequestSchema } from "../bots/cv.js";
import { CvVersionSchema, QaReviewRecordSchema } from "../domain/cv-version.js";
import { CompanySchema, JobSchema, SkipDecisionSchema } from "../domain/job.js";
import { ApplicationOriginSchema, ApplicationStatusSchema } from "../domain/application.js";
import { FileRefSchema } from "./common.js";
import { ReviewGuidanceSchema } from "./guidance.js";

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
  /**
   * Apply was denied before it ran (e.g. its token expired) and waits for Ba to approve again:
   * Approve issues a new token for the same application and CV version (PM M2). W3a, additive.
   */
  approveAgain: z.boolean().optional(),
  /** PM2 S16: the company research failed for good; CV tailored without a profile. Phase 3 QA, additive. */
  companyMissing: z.boolean().optional(),
  /**
   * PM2 S15: the card's dry run has settled (not one that reported "submitted" and waits for Ba's
   * check); Approve without dryRun now applies live with the same CV. Phase 3 QA, additive.
   */
  dryRunSettled: z.boolean().optional(),
  /**
   * PM3 S2, §10.2 rule 5: this card is an "apply again" (started by Lead or by Ba's Apply again
   * button) and Ba applied to the job before: that earlier application's date and status, so Ba
   * knows before approving a second one. Null on every other card. F4, additive.
   */
  appliedBefore: z
    .object({
      applicationId: IdSchema,
      /** When it was sent, or when it was approved if it never was. */
      at: IsoDateTimeSchema,
      status: ApplicationStatusSchema,
      origin: ApplicationOriginSchema,
    })
    .nullable()
    .optional(),
  /**
   * W5: a find-only source (Upwork, `findOnlySourceOf`): Approve is refused (FIND_ONLY_REASON) and
   * the card shows FIND_ONLY_NOTE with a link to the posting. Additive.
   */
  findOnly: z.boolean().optional(),
});

export const ReviewCvOptionSchema = z.object({
  cvVersion: CvVersionSchema,
  /** All QA rounds for this language, oldest first. */
  qaRounds: z.array(QaReviewRecordSchema),
  pdf: FileRefSchema.nullable(),
  /** CV guidance (additive, REQ-40): the review result of the CV round shown, or null when there is none. */
  guidance: ReviewGuidanceSchema.nullable().optional(),
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
  /** §12 dry-run acceptance: fill and screenshot, never submit (PM2 S2). */
  dryRun: z.boolean().optional(),
});
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>;

export const ApproveResponseSchema = z.object({
  /** Null for an uploaded JD with no apply link: Approve only produced the CV PDF (§7.3b, PM2 S2). */
  applicationId: IdSchema.nullable(),
  /** Null when there is nothing to submit (no apply link, §7.3b). */
  taskId: IdSchema.nullable(),
  approval: z.object({ expiresAt: IsoDateTimeSchema, allowedDomains: z.array(DomainSchema) }).nullable(),
  /** This approval replaced a denied or expired token ("approve again", PM M2). W3a, additive. */
  reapproval: z.boolean().optional(),
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
