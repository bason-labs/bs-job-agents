// Task input payloads (the JSON the runner puts in the prompt, §5.5 step 1).
import { z } from "zod";
import {
  CurrencySchema,
  CvLanguageSchema,
  DomainSchema,
  IdSchema,
  LIMITS,
  SearchSourceSchema,
  Sha256Schema,
  UrlSchema,
} from "../common/primitives.js";
import { SalaryPolicySchema, SearchProfileFieldsBaseSchema } from "../domain/search-profile.js";
import { CvDraftSchema } from "./cv.js";
import { CONVERSATION_TASK_KINDS } from "./definition.js";
import { QaFixSchema } from "./qa.js";
import { CompanyProfileSchema, JobCandidateSchema } from "./research.js";

/** research.scan: one source → JobCandidate[] (UC-03). */
export const ResearchScanInputSchema = z.object({
  source: SearchSourceSchema,
  criteria: SearchProfileFieldsBaseSchema,
  maxPageViews: z.number().int().positive().nullable(),
});

/** research.single: one job URL (§7.3). */
export const ResearchSingleInputSchema = z.object({ url: UrlSchema });

/** research.file: an uploaded JD (§7.3b). */
export const ResearchFileInputSchema = z.object({
  uploadId: IdSchema,
  path: z.string().min(1),
  filename: z.string().min(1),
  mime: z.string().min(1),
});

/** research.fit: candidate + master CV (UC-04). */
export const ResearchFitInputSchema = z.object({
  jobId: IdSchema,
  job: JobCandidateSchema,
  masterCvVersion: z.number().int().positive(),
});

/** research.company (UC-05). */
export const ResearchCompanyInputSchema = z.object({
  name: z.string().min(1),
  website: UrlSchema.nullable(),
});

/**
 * A CV template frame on a protected Figma page (§6.2 Templates), as the orchestrator lists it
 * from its "before" fingerprint of the CV task: the CV bot duplicates one into Drafts.
 */
export const CvTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  pageId: z.string().min(1),
  pageName: z.string(),
  /** The section the template sits in, if any (e.g. "EN"). */
  sectionName: z.string().nullable(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
export type CvTemplate = z.infer<typeof CvTemplateSchema>;

/** cv.tailor (UC-06, UC-07 fix rounds, UC-09 Ba's comment). */
export const CvTailorInputSchema = z.object({
  jobId: IdSchema,
  job: JobCandidateSchema,
  company: CompanyProfileSchema.nullable(),
  language: CvLanguageSchema,
  round: z.number().int().min(1).max(LIMITS.qaMaxRounds),
  fixes: z.array(QaFixSchema),
  comment: z.string().nullable().describe("Ba's request-changes comment"),
  previousCvVersionId: IdSchema.nullable(),
  masterCvVersion: z.number().int().positive(),
  /** Added by the engine right before the spawn, under the Figma lock (W2a, coordinator B). */
  templates: z.array(CvTemplateSchema).optional(),
});

/** qa.review (§5.2 QA). */
export const QaReviewInputSchema = z.object({
  jobId: IdSchema,
  cvVersionId: IdSchema,
  job: JobCandidateSchema,
  company: CompanyProfileSchema.nullable(),
  draft: CvDraftSchema,
  pdfText: z.string().describe("Extracted with a pdfminer/PDF.js-style extractor (§6.2)"),
  masterCvVersion: z.number().int().positive(),
});

/** Ba's answers to pending questions (UC-12); null value = Skip — leave blank. */
export const QuestionAnswerSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1),
  value: z.string().nullable(),
});

/** apply.submit (§5.2 Apply, UC-11). Only queued with a valid approval token (§10.2 rule 1). */
export const ApplySubmitInputSchema = z.object({
  applicationId: IdSchema,
  jobId: IdSchema,
  cvVersionId: IdSchema,
  jobUrl: UrlSchema,
  expectedCompany: z.string().min(1),
  expectedTitle: z.string().min(1),
  approvalToken: z.string().min(1),
  allowedDomains: z.array(DomainSchema).min(1),
  pdfPath: z.string().min(1),
  pdfSha256: Sha256Schema,
  introText: z.string().nullable(),
  savedAnswers: z.array(z.object({ key: z.string().min(1), label: z.string().min(1), answer: z.string() })),
  answers: z.array(QuestionAnswerSchema),
  formDefaults: z.object({
    salaryPolicy: SalaryPolicySchema,
    salaryAmount: z.number().int().positive().nullable(),
    currency: CurrencySchema.nullable(),
  }),
  /** Dry-run acceptance (§12): fill and screenshot, never click submit; report needs_check. */
  dryRun: z.boolean(),
});
export type ApplySubmitInput = z.infer<typeof ApplySubmitInputSchema>;

/** Consult (UC-25) / discussion (UC-15) input. */
export const ConversationInputSchema = z.object({
  roomId: IdSchema,
  messageId: IdSchema,
  text: z.string(),
  history: z.array(z.object({ author: z.string(), text: z.string() })),
  uploadIds: z.array(IdSchema),
});

export const BOT_TASK_INPUT_SCHEMAS = {
  "research.scan": ResearchScanInputSchema,
  "research.single": ResearchSingleInputSchema,
  "research.file": ResearchFileInputSchema,
  "research.fit": ResearchFitInputSchema,
  "research.company": ResearchCompanyInputSchema,
  "cv.tailor": CvTailorInputSchema,
  "qa.review": QaReviewInputSchema,
  "apply.submit": ApplySubmitInputSchema,
} as const;
export type BotTaskKey = keyof typeof BOT_TASK_INPUT_SCHEMAS;

// ---------------------------------------------------------------- prompt inputs (PM S5)

/**
 * Keys that never reach a model, at any depth (PM S5). The approval token is a capability:
 * the trust guard checks it before spawning; the bot never needs it.
 */
export const PROMPT_FORBIDDEN_KEYS = ["approvalToken"] as const;

/** apply.submit as the bot sees it: everything except the approval token. Strict, so a stray token is an error. */
export const ApplyPromptInputSchema = ApplySubmitInputSchema.omit({ approvalToken: true }).strict();
export type ApplyPromptInput = z.infer<typeof ApplyPromptInputSchema>;

/** Split an apply.submit input into the prompt part and the guard-only token (PM S5). */
export function splitApplySubmitInput(input: ApplySubmitInput): { prompt: ApplyPromptInput; approvalToken: string } {
  const { approvalToken, ...prompt } = input;
  return { prompt, approvalToken };
}

/**
 * Task inputs as the runner puts them in the prompt (§5.5 step 1): `BOT_TASK_INPUT_SCHEMAS`
 * without guard-only fields. The engine validates the full input, then hands the runner this part.
 * Strict (QA Phase 2): a key the schema does not know is an error at the runner, never something
 * silently sent to a model (the engine-side task schemas keep stripping unknown keys).
 */
export const BOT_TASK_PROMPT_INPUT_SCHEMAS = {
  "research.scan": ResearchScanInputSchema.strict(),
  "research.single": ResearchSingleInputSchema.strict(),
  "research.file": ResearchFileInputSchema.strict(),
  "research.fit": ResearchFitInputSchema.strict(),
  "research.company": ResearchCompanyInputSchema.strict(),
  "cv.tailor": CvTailorInputSchema.strict(),
  "qa.review": QaReviewInputSchema.strict(),
  "apply.submit": ApplyPromptInputSchema,
} as const satisfies Record<BotTaskKey, z.ZodTypeAny>;

/** Consult (UC-25) / discussion (UC-15) input as the bot sees it: strict, like the task prompt inputs. */
export const ConversationPromptInputSchema = ConversationInputSchema.strict();

/** Schema for the prompt input of `bot.kind`: consult/discussion use ConversationInput; null when none is defined (Lead chat). */
export function promptInputSchemaFor(bot: string, kind: string): z.ZodTypeAny | null {
  if ((CONVERSATION_TASK_KINDS as readonly string[]).includes(kind)) return ConversationPromptInputSchema;
  const key = `${bot}.${kind}`;
  return Object.prototype.hasOwnProperty.call(BOT_TASK_PROMPT_INPUT_SCHEMAS, key)
    ? BOT_TASK_PROMPT_INPUT_SCHEMAS[key as BotTaskKey]
    : null;
}

/** JSONPath-like locations of `PROMPT_FORBIDDEN_KEYS` anywhere in `value` (empty = safe to put in a prompt). */
export function findForbiddenPromptKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findForbiddenPromptKeys(v, `${path}[${i}]`));
  if (typeof value !== "object" || value === null) return [];
  const found: string[] = [];
  const nested: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if ((PROMPT_FORBIDDEN_KEYS as readonly string[]).includes(k)) found.push(`${path}.${k}`);
    nested.push(...findForbiddenPromptKeys(v, `${path}.${k}`));
  }
  return [...nested, ...found];
}

export type ResearchScanInput = z.infer<typeof ResearchScanInputSchema>;
export type ResearchSingleInput = z.infer<typeof ResearchSingleInputSchema>;
export type ResearchFileInput = z.infer<typeof ResearchFileInputSchema>;
export type ResearchFitInput = z.infer<typeof ResearchFitInputSchema>;
export type ResearchCompanyInput = z.infer<typeof ResearchCompanyInputSchema>;
export type CvTailorInput = z.infer<typeof CvTailorInputSchema>;
export type QaReviewInput = z.infer<typeof QaReviewInputSchema>;
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;
export type ConversationInput = z.infer<typeof ConversationInputSchema>;
