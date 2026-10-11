// Task input payloads (the JSON the runner puts in the prompt, §5.5 step 1).
import { z } from "zod";
import {
  BotNameSchema,
  CurrencySchema,
  CvLanguageSchema,
  DomainSchema,
  IdSchema,
  LIMITS,
  PublicUrlSchema,
  SearchSourceSchema,
  Sha256Schema,
  UrlSchema,
} from "../common/primitives.js";
import { FactTypeSchema } from "../domain/master-cv.js";
import { SalaryPolicySchema, SearchProfileFieldsBaseSchema } from "../domain/search-profile.js";
import { CvDraftSchema } from "./cv.js";
import { FACT_DRAFT_TEXT_MAX } from "./fact-draft.js";
import { CONVERSATION_TASK_KINDS } from "./definition.js";
import { QaFixSchema } from "./qa.js";
import { CompanyProfileSchema, JobCandidateSchema } from "./research.js";

/** research.scan: one source → JobCandidate[] (UC-03). */
export const ResearchScanInputSchema = z.object({
  source: SearchSourceSchema,
  criteria: SearchProfileFieldsBaseSchema,
  maxPageViews: z.number().int().positive().nullable(),
  /**
   * W4a handoff: how many postings this scan may return at most (3 × criteria.maxJobs, at most 30;
   * the fit step keeps the best maxJobs). Optional: absent on inputs stored before it.
   */
  candidateLimit: z.number().int().positive().max(30).optional(),
});

/** research.single: one job URL (§7.3). PM2 M2: a public site, never Ba's Mac or LAN. */
export const ResearchSingleInputSchema = z.object({ url: PublicUrlSchema });

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

/**
 * cv.fact_draft (owner request 2026-10-11): Ba's own words from the Master CV screen, the question he
 * answered (CV's fact request, if any) and his existing facts' ids, types, organisations and dates,
 * so CV can refer to a role ("at Gradion") and pick new ids. No tools, no Figma, no files.
 */
export const CvFactDraftInputSchema = z.object({
  text: z.string().trim().min(1).max(FACT_DRAFT_TEXT_MAX).describe("Ba's own words (EN or VI): the only source of facts"),
  question: z
    .object({
      topic: z.string().min(1),
      question: z.string().min(1),
      reason: z.string(),
      company: z.string(),
    })
    .strict()
    .nullable()
    .describe("CV's fact request Ba answers (it came from a JD), or null"),
  existingFacts: z.array(
    z
      .object({
        id: z.string().min(1),
        type: FactTypeSchema,
        org: z.string().nullable(),
        dates: z.string().nullable(),
      })
      .strict(),
  ),
  masterCvVersion: z.number().int().positive(),
});
export type CvFactDraftInput = z.infer<typeof CvFactDraftInputSchema>;

/**
 * Live run 1 (F5): facts about the exported PDF that the orchestrator itself verified (its own
 * Figma export and PDF.js read, §6.2). QA uses them for the page-count / one-page A4 checks
 * instead of guessing from the extracted text. Strict: nothing else rides along.
 */
export const VerifiedPdfFactsSchema = z
  .object({
    pageCount: z.number().int().nonnegative(),
    onePageA4: z.boolean().describe("Exactly one page, A4 portrait"),
    widthPt: z.number().nonnegative().nullable().describe("First page width in points (A4 portrait: 595.28)"),
    heightPt: z.number().nonnegative().nullable().describe("First page height in points (A4 portrait: 841.89)"),
    sha256: Sha256Schema,
    textChars: z.number().int().nonnegative().describe("Characters of pdfText the orchestrator extracted"),
  })
  .strict();
export type VerifiedPdfFacts = z.infer<typeof VerifiedPdfFactsSchema>;

/** qa.review (§5.2 QA). */
export const QaReviewInputSchema = z.object({
  jobId: IdSchema,
  cvVersionId: IdSchema,
  job: JobCandidateSchema,
  company: CompanyProfileSchema.nullable(),
  draft: CvDraftSchema,
  pdfText: z.string().describe("Extracted with a pdfminer/PDF.js-style extractor (§6.2)"),
  /** Additive (F5): absent on inputs stored before it. */
  pdf: VerifiedPdfFactsSchema.optional().describe("Orchestrator-verified facts about the exported PDF"),
  /**
   * Additive (live run 1, F6): the target language of the CV version under review, set by the
   * orchestrator from the version itself (trusted). QA checks the CV's language against this,
   * never against the JD's: a VI JD gets both a VI and an EN version (§6.3).
   */
  cvLanguage: CvLanguageSchema.optional().describe("Target language of this CV version (trusted, set by the orchestrator)"),
  /** Additive (F6): every CV language this JD gets, from cvLanguagesForJd(job.language) (§6.3). */
  expectedLanguages: z
    .array(CvLanguageSchema)
    .min(1)
    .optional()
    .describe("CV languages this JD gets (§6.3: VI JD → vi and en; otherwise en)"),
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
  /** PM2 M2: Apply starts here, in Ba's Chrome: a public site only. */
  jobUrl: PublicUrlSchema,
  expectedCompany: z.string().min(1),
  expectedTitle: z.string().min(1),
  approvalToken: z.string().min(1),
  allowedDomains: z.array(DomainSchema).min(1),
  pdfPath: z.string().min(1),
  pdfSha256: Sha256Schema,
  /**
   * Ba's master facts (§6.1) for the form's values: the orchestrator's copy of master-cv.yaml in
   * this task's own read folder (W4c handoff). Optional: absent on inputs stored before the copy.
   */
  masterCvPath: z.string().min(1).optional(),
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

/**
 * lead.chat (UC-01, UC-14, UC-24, UC-25 a; PM2 S2): Ba's message in the Lead chat, or a request a
 * consult-mode bot handed over (`handoff`, null otherwise). The prompt puts `history` and `handoff`
 * in UNTRUSTED_CONTENT blocks (§10.2 rule 4): they hold text other bots wrote.
 */
export const LeadChatInputSchema = ConversationInputSchema.extend({
  handoff: z
    .object({
      fromBot: BotNameSchema,
      request: z.string().min(1).describe("The work request, as the consult-mode bot restated it"),
    })
    .strict()
    .nullable(),
});
export type LeadChatInput = z.infer<typeof LeadChatInputSchema>;

export const BOT_TASK_INPUT_SCHEMAS = {
  "research.scan": ResearchScanInputSchema,
  "research.single": ResearchSingleInputSchema,
  "research.file": ResearchFileInputSchema,
  "research.fit": ResearchFitInputSchema,
  "research.company": ResearchCompanyInputSchema,
  "cv.tailor": CvTailorInputSchema,
  "cv.fact_draft": CvFactDraftInputSchema,
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
  "cv.fact_draft": CvFactDraftInputSchema.strict(),
  "qa.review": QaReviewInputSchema.strict(),
  "apply.submit": ApplyPromptInputSchema,
} as const satisfies Record<BotTaskKey, z.ZodTypeAny>;

/** Consult (UC-25) / discussion (UC-15) input as the bot sees it: strict, like the task prompt inputs. */
export const ConversationPromptInputSchema = ConversationInputSchema.strict();

/** lead.chat as Lead sees it (PM2 S2): strict. */
export const LeadChatPromptInputSchema = LeadChatInputSchema.strict();

/** Schema for the prompt input of `bot.kind`: consult/discussion use ConversationInput, Lead's chat LeadChatInput; null when none is defined. */
export function promptInputSchemaFor(bot: string, kind: string): z.ZodTypeAny | null {
  if ((CONVERSATION_TASK_KINDS as readonly string[]).includes(kind)) return ConversationPromptInputSchema;
  if (bot === "lead" && kind === "chat") return LeadChatPromptInputSchema;
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
