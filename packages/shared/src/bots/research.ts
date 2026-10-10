// Research bot outputs (§5.2, UC-03/04/05). Three schemas, one per task family:
// scan (kinds scan | single | file) → JobCandidate[]; fit → FitScore; company → CompanyProfile.
import { z } from "zod";
import {
  IsoDateTimeSchema,
  JobSourceSchema,
  LanguageCodeSchema,
  UrlSchema,
  WorkModeSchema,
} from "../common/primitives.js";
import { botEnvelopeShape } from "./self-check.js";

/** Why a browser task could not continue on its own (UC-03 a, UC-17). */
export const BrowserBlockSchema = z.strictObject({
  reason: z.enum(["needs_login", "captcha"]),
  site: z.string().min(1).describe("Host that needs Ba, e.g. topcv.vn"),
  detail: z.string().nullable(),
});
export type BrowserBlock = z.infer<typeof BrowserBlockSchema>;

/** UC-03: one job found by a scan. */
export const JobCandidateSchema = z.strictObject({
  source: JobSourceSchema.describe("topcv | itviec | linkedin | career_site | link | file"),
  url: UrlSchema.nullable().describe("Job posting / apply URL. Null only for an uploaded JD with no posting found (§7.3b)."),
  title: z.string().min(1),
  company: z.string().min(1),
  companyWebsite: UrlSchema.nullable(),
  location: z.string().min(1),
  workMode: WorkModeSchema.nullable(),
  salaryText: z.string().nullable().describe("Salary as shown, e.g. '25–35 triệu' or '2,000–2,800 USD'; null if not listed"),
  postedAt: IsoDateTimeSchema.nullable(),
  language: LanguageCodeSchema.describe("Detected JD language, ISO 639-1 (vi, en, …)"),
  jdText: z.string().min(1).describe("Full JD text, not a snippet"),
});
export type JobCandidate = z.infer<typeof JobCandidateSchema>;

export const ResearchScanOutputSchema = z.strictObject({
  jobs: z.array(JobCandidateSchema).describe("Empty when the source has no results (UC-03 d)"),
  pageViews: z.number().int().nonnegative().describe("Pages opened in Chrome (LinkedIn ≤ 40, UC-03 c)"),
  blocked: BrowserBlockSchema.nullable().describe("Set when login or a CAPTCHA stopped the scan"),
  ...botEnvelopeShape,
});
export type ResearchScanOutput = z.infer<typeof ResearchScanOutputSchema>;

/** UC-04: fit of one candidate against the master CV. */
export const FitScoreSchema = z.strictObject({
  score: z.number().int().min(0).max(100),
  reasons: z.array(z.string().min(1)).describe("Why it fits"),
  gaps: z.array(z.string().min(1)).describe("What the JD asks for that master data lacks"),
});
export type FitScore = z.infer<typeof FitScoreSchema>;

export const ResearchFitOutputSchema = z.strictObject({
  fit: FitScoreSchema,
  ...botEnvelopeShape,
});
export type ResearchFitOutput = z.infer<typeof ResearchFitOutputSchema>;

export const CompanyConfidenceSchema = z.enum(["normal", "low_confidence"]);
export type CompanyConfidence = z.infer<typeof CompanyConfidenceSchema>;

export const SourceRefSchema = z.strictObject({
  title: z.string().min(1),
  url: UrlSchema,
});

/** UC-05 */
export const CompanyProfileSchema = z
  .strictObject({
    name: z.string().min(1),
    website: UrlSchema.nullable(),
    industry: z.string().nullable(),
    size: z.string().nullable().describe("e.g. '~250 people'"),
    productOrOutsource: z.enum(["product", "outsource", "mixed", "unknown"]),
    culture: z.array(z.string().min(1)),
    benefits: z.array(z.string().min(1)),
    reviewsSummary: z.string().nullable(),
    sources: z.array(SourceRefSchema).describe("At least 2 independent sources unless low_confidence"),
    confidence: CompanyConfidenceSchema.describe("low_confidence when little public information exists (UC-05 b)"),
    researchedAt: IsoDateTimeSchema,
  })
  .superRefine((v, ctx) => {
    if (v.confidence === "normal" && v.sources.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources"],
        message: "a normal-confidence profile cites at least 2 independent sources",
      });
    }
  });
export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;

export const ResearchCompanyOutputSchema = z.strictObject({
  company: CompanyProfileSchema,
  ...botEnvelopeShape,
});
export type ResearchCompanyOutput = z.infer<typeof ResearchCompanyOutputSchema>;
