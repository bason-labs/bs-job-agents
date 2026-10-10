// Applications screen, submission record panel, export (UC-13, UC-13b).
import { z } from "zod";
import { CvLanguageSchema, IdSchema, IsoDateTimeSchema, UrlSchema } from "../common/primitives.js";
import { ApplicationSchema, ApplicationStatusSchema, SubmissionRecordSchema } from "../domain/application.js";
import { ExportSchema } from "../domain/export.js";
import { FileRefSchema } from "./common.js";

const JobSummarySchema = z.object({
  id: IdSchema,
  title: z.string(),
  company: z.string(),
  url: UrlSchema.nullable(),
  source: z.string(),
});

const CvVersionSummarySchema = z.object({
  id: IdSchema,
  /** e.g. NOVAPAY_SENIOR-FRONTEND_EN_v1 */
  label: z.string(),
  language: CvLanguageSchema,
  pdfFileId: z.string().nullable(),
  figmaFrameUrl: UrlSchema.nullable(),
});

export const ApplicationListItemSchema = z.object({
  application: ApplicationSchema,
  job: JobSummarySchema,
  cvVersion: CvVersionSummarySchema.nullable(),
  confirmationScreenshotFileId: z.string().nullable(),
  /** Imported or missing parts ("not captured"). */
  partialRecord: z.boolean(),
});
export type ApplicationListItem = z.infer<typeof ApplicationListItemSchema>;

export const ApplicationsResponseSchema = z.object({
  applications: z.array(ApplicationListItemSchema),
  lastExportAt: IsoDateTimeSchema.nullable(),
});

/** Submission record side panel (UC-13). */
export const ApplicationDetailSchema = z.object({
  application: ApplicationSchema,
  job: JobSummarySchema,
  cvVersion: CvVersionSummarySchema.nullable(),
  submission: SubmissionRecordSchema.nullable(),
  /** Files for the viewer (uploaded CV, screenshots, JD snapshot). */
  files: z.array(FileRefSchema),
});
export type ApplicationDetail = z.infer<typeof ApplicationDetailSchema>;

/** Manual status change; the server checks canChangeApplicationStatus. */
export const ApplicationStatusChangeRequestSchema = z.object({
  status: ApplicationStatusSchema,
  note: z.string().nullable(),
});
export type ApplicationStatusChangeRequest = z.infer<typeof ApplicationStatusChangeRequestSchema>;

/** ⬇ Export all (ZIP). */
export const ExportRequestSchema = z.object({}).strict();
export const ExportResponseSchema = z.object({ export: ExportSchema, downloadUrl: z.string().min(1) });
export type ExportResponse = z.infer<typeof ExportResponseSchema>;
