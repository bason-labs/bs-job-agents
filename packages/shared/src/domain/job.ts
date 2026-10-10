// Jobs and companies (§9 `jobs`, `companies`; UC-03/04/05/10).
import { z } from "zod";
import {
  IdSchema,
  IsoDateTimeSchema,
  JobSourceSchema,
  LanguageCodeSchema,
  UrlSchema,
  WorkModeSchema,
} from "../common/primitives.js";
import { CompanyConfidenceSchema, CompanyProfileSchema } from "../bots/research.js";

export const JOB_STATUSES = ["new", "below_threshold", "selected", "reviewing", "approved", "applied", "skipped"] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** UC-10 */
export const SKIP_REASONS = [
  "salary_low",
  "outsourcing",
  "location",
  "tech_mismatch",
  "company_culture",
  "seniority",
  "other",
] as const;
export const SkipReasonSchema = z.enum(SKIP_REASONS);
export type SkipReason = z.infer<typeof SkipReasonSchema>;

export const SKIP_REASON_LABELS = {
  salary_low: "Salary too low",
  outsourcing: "Outsourcing company",
  location: "Location",
  tech_mismatch: "Tech stack mismatch",
  company_culture: "Company culture",
  seniority: "Seniority",
  other: "Other",
} as const satisfies Record<SkipReason, string>;

/** Ba's skip decision; "other" needs free text. */
export const SkipDecisionSchema = z
  .object({ reason: SkipReasonSchema, note: z.string().trim().min(1).nullable() })
  .superRefine((v, ctx) => {
    if (v.reason === "other" && !v.note) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["note"], message: "tell us why (other)" });
    }
  });
export type SkipDecision = z.infer<typeof SkipDecisionSchema>;

export const JobSchema = z
  .object({
    id: IdSchema,
    source: JobSourceSchema,
    url: UrlSchema.nullable(),
    /** Dedupe key 1 (UC-04). */
    canonicalUrl: UrlSchema.nullable(),
    /** Dedupe key 2: hash of company + title + location (UC-04). */
    dedupeHash: z.string().min(1),
    title: z.string().min(1),
    companyId: IdSchema.nullable(),
    /** Company name as posted (denormalised for lists). */
    company: z.string().min(1),
    location: z.string(),
    workMode: WorkModeSchema.nullable(),
    salaryText: z.string().nullable(),
    language: LanguageCodeSchema,
    jdText: z.string(),
    fitScore: z.number().int().min(0).max(100).nullable(),
    fitReasons: z.array(z.string()),
    gaps: z.array(z.string()),
    status: JobStatusSchema,
    skipReason: SkipReasonSchema.nullable(),
    skipNote: z.string().nullable(),
    /** QA flagged prompt injection; Apply disabled until Ba confirms (UC-07 b). */
    injectionFlagged: z.boolean(),
    /** When Ba confirmed a flagged job is safe to apply to (UC-07 b); null = not confirmed. */
    injectionClearedAt: IsoDateTimeSchema.nullable(),
    firstSeenAt: IsoDateTimeSchema,
  })
  .superRefine((v, ctx) => {
    if (v.injectionClearedAt !== null && !v.injectionFlagged) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["injectionClearedAt"],
        message: "only a flagged job can be confirmed",
      });
    }
  });
export type Job = z.infer<typeof JobSchema>;

/** §10.2 rule 4, UC-07 b: Apply stays disabled for a flagged job until Ba confirms it. */
export function isApplyBlockedByInjection(job: Pick<Job, "injectionFlagged" | "injectionClearedAt">): boolean {
  return job.injectionFlagged && job.injectionClearedAt === null;
}

export const CompanySchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  website: UrlSchema.nullable(),
  profile: CompanyProfileSchema.nullable(),
  confidence: CompanyConfidenceSchema.nullable(),
  researchedAt: IsoDateTimeSchema.nullable(),
});
export type Company = z.infer<typeof CompanySchema>;
