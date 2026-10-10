// Apply bot output (§5.2 Apply, UC-11, UC-12).
import { z } from "zod";
import { IsoDateTimeSchema, Sha256Schema, UrlSchema } from "../common/primitives.js";
import { botEnvelopeShape } from "./self-check.js";

/** Where a submitted field value came from (UC-13 submission record). */
export const FieldSourceSchema = z.enum([
  "master_cv",
  "saved_answer",
  "ba_answer",
  "search_profile",
  "form_defaults",
  "generated",
  "skipped",
]);
export type FieldSource = z.infer<typeof FieldSourceSchema>;

/** UI labels (prototype `sourceLabel`). */
export const FIELD_SOURCE_LABELS = {
  master_cv: "master CV",
  saved_answer: "saved answer",
  ba_answer: "your answer",
  search_profile: "search criteria",
  form_defaults: "form defaults",
  generated: "generated",
  skipped: "left blank — optional",
} as const satisfies Record<FieldSource, string>;

export const FilledFieldSchema = z.strictObject({
  label: z.string().min(1).describe("Label as shown on the form"),
  name: z.string().nullable().describe("Field name/id attribute if known"),
  value: z.string().nullable().describe("Value entered; null only when skipped"),
  source: FieldSourceSchema,
  required: z.boolean(),
});
export type FilledField = z.infer<typeof FilledFieldSchema>;

export const PendingQuestionKindSchema = z.enum(["salary", "text", "choice", "date", "number", "other"]);

/** UC-12: a field Apply could not fill. Required ones pause the submit. */
export const PendingQuestionSchema = z.strictObject({
  field: z.string().min(1).describe("Field name/id, or the label if no name"),
  label: z.string().min(1),
  required: z.boolean(),
  kind: PendingQuestionKindSchema.describe("salary questions also offer Negotiable / Thỏa thuận"),
  options: z.array(z.string()).nullable().describe("Choices for select/radio fields"),
});
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;

export const ConsentSchema = z.strictObject({
  ticked: z.boolean(),
  text: z.string().describe("The consent wording on the form"),
});

export const UploadedFileSchema = z.strictObject({
  filename: z.string().min(1),
  sha256: Sha256Schema,
});

export const ApplyPauseReasonSchema = z.strictObject({
  reason: z.enum(["needs_answer", "needs_login", "captcha", "domain_confirm"]),
  site: z.string().nullable().describe("Host involved, e.g. the ATS domain for domain_confirm (UC-11 e)"),
  detail: z.string().nullable(),
});
export type ApplyPauseReason = z.infer<typeof ApplyPauseReasonSchema>;

/** UC-11 step 5: the posting as it is right now. */
export const JdSnapshotCaptureSchema = z.strictObject({
  url: UrlSchema,
  title: z.string().min(1),
  company: z.string().min(1),
  salaryText: z.string().nullable(),
  jdText: z.string().min(1),
  pageScreenshot: z.string().nullable().describe("Path of the full-page screenshot"),
  capturedAt: IsoDateTimeSchema,
});
export type JdSnapshotCapture = z.infer<typeof JdSnapshotCaptureSchema>;

export const ApplyStatusSchema = z.enum(["submitted", "needs_check", "paused"]);
export type ApplyStatus = z.infer<typeof ApplyStatusSchema>;

const applyResultShape = {
  status: ApplyStatusSchema,
  fieldsFilled: z.array(FilledFieldSchema),
  introText: z.string().nullable(),
  consent: ConsentSchema.nullable(),
  uploadedFile: UploadedFileSchema.nullable(),
  preSubmitScreenshot: z.string().nullable().describe("Path of the filled-form screenshot"),
  confirmationScreenshot: z.string().nullable(),
  confirmationText: z.string().nullable(),
  finalUrl: UrlSchema.nullable(),
  pendingQuestions: z.array(PendingQuestionSchema),
  pauseReason: ApplyPauseReasonSchema.nullable(),
  jdSnapshot: JdSnapshotCaptureSchema.nullable(),
};

type ApplyResultShape = z.infer<z.ZodObject<typeof applyResultShape>>;

function checkApplyResult(v: ApplyResultShape, ctx: z.RefinementCtx): void {
  v.fieldsFilled.forEach((f, i) => {
    if (f.source === "skipped" && (f.required || f.value !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fieldsFilled", i],
        message: "a skipped field must be optional and left blank (value null)",
      });
    }
    if (f.source !== "skipped" && f.value === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fieldsFilled", i, "value"], message: "only skipped fields may be blank" });
    }
  });
  if (v.status === "submitted") {
    if (!v.uploadedFile) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["uploadedFile"], message: "a submission needs the uploaded file and its SHA-256" });
    }
    if (!v.preSubmitScreenshot) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["preSubmitScreenshot"], message: "a submission needs a pre-submit screenshot" });
    }
    if (!v.confirmationText && !v.confirmationScreenshot) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmationText"],
        message: "submitted needs confirmation text or a screenshot; otherwise report needs_check",
      });
    }
  }
  if (v.status === "paused" && !v.pauseReason && v.pendingQuestions.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pauseReason"], message: "paused needs a pauseReason or pendingQuestions" });
  }
}

/** ApplyResult (§5.2). */
export const ApplyResultSchema = z.strictObject(applyResultShape).superRefine(checkApplyResult);
export type ApplyResult = z.infer<typeof ApplyResultSchema>;

export const ApplyOutputSchema = z.strictObject({ ...applyResultShape, ...botEnvelopeShape }).superRefine(checkApplyResult);
export type ApplyOutput = z.infer<typeof ApplyOutputSchema>;

/** True when Lead must ask Ba something before Apply can continue (UC-12). */
export function needsBaAnswer(result: Pick<ApplyResult, "status" | "pendingQuestions">): boolean {
  return result.status === "paused" && result.pendingQuestions.length > 0;
}
