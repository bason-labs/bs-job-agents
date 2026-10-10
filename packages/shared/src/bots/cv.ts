// CV bot output (§5.2 CV, §6, UC-06). Every bullet cites master facts (§10.2 rule 3).
import { z } from "zod";
import { CvLanguageSchema, UrlSchema } from "../common/primitives.js";
import { botEnvelopeShape } from "./self-check.js";

/** §6.2 layout freedom: fonts from an allowed list. */
export const CV_FONTS = ["Be Vietnam Pro", "Inter", "Space Grotesk", "Arial"] as const;
export const CvFontSchema = z.enum(CV_FONTS);

export const FactIdsSchema = z
  .array(z.string().min(1))
  .min(1)
  .describe("Ids of master-cv.yaml facts that support this text (never empty)");

export const CvBulletSchema = z.strictObject({
  text: z.string().min(1),
  factIds: FactIdsSchema,
});
export type CvBullet = z.infer<typeof CvBulletSchema>;

export const CvSectionKindSchema = z.enum(["summary", "experience", "projects", "skills", "education", "other"]);

export const CvItemSchema = z.strictObject({
  heading: z.string().nullable().describe("e.g. role and organisation"),
  subheading: z.string().nullable().describe("e.g. dates, location"),
  bullets: z.array(CvBulletSchema),
});

export const CvSectionSchema = z.strictObject({
  kind: CvSectionKindSchema,
  title: z.string().min(1).describe("Section title in the CV language"),
  items: z.array(CvItemSchema).min(1),
});

export const CvLayoutSchema = z.strictObject({
  template: z.string().min(1).describe("Template frame the draft was cloned from"),
  font: CvFontSchema,
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "hex colour such as #6c5ce7"),
  columns: z.union([z.literal(1), z.literal(2)]),
  sectionOrder: z.array(CvSectionKindSchema).min(1),
});

/** The CV content written from master facts. */
export const TailoredCvSchema = z.strictObject({
  headline: z.string().min(1),
  contactLine: z.string().min(1).describe("Always present (§6.2 fixed limits)"),
  summary: CvBulletSchema.nullable(),
  sections: z.array(CvSectionSchema).min(1),
  layout: CvLayoutSchema,
});
export type TailoredCv = z.infer<typeof TailoredCvSchema>;

/** §6.1: a fact CV believes is missing ("Docker?"). Lead asks Ba. */
export const FactRequestSchema = z.strictObject({
  topic: z.string().min(1).describe("e.g. Docker"),
  question: z.string().min(1).describe("Question for Ba, e.g. 'Have you used Docker in production?'"),
  reason: z.string().min(1).describe("Why the JD makes it relevant"),
});
export type FactRequest = z.infer<typeof FactRequestSchema>;

/** CvDraft (§5.2). pdfPath is filled by the orchestrator after export (§6.2), so the bot sends null. */
export const CvDraftSchema = z.strictObject({
  language: CvLanguageSchema,
  tailored: TailoredCvSchema,
  figmaFrameName: z
    .string()
    .regex(/^.+_.+_(EN|VI)_v\d+$/, "frame name <COMPANY>_<ROLE>_<LANG>_v<n>")
    // The pattern is checked by Zod only (patterns stay out of the JSON Schema), so say it here.
    .describe("Drafts frame name <COMPANY>_<ROLE>_<LANG>_v<n>, LANG is EN or VI, e.g. NOVAPAY_SENIOR-FE_EN_v1"),
  figmaFrameUrl: UrlSchema,
  pdfPath: z.string().min(1).nullable(),
  changeNotes: z.array(z.string().min(1)),
  factRequests: z.array(FactRequestSchema).describe("Missing facts; CV continues without them, never invents"),
});
export type CvDraft = z.infer<typeof CvDraftSchema>;

export const CvOutputSchema = CvDraftSchema.extend(botEnvelopeShape).strict();
export type CvOutput = z.infer<typeof CvOutputSchema>;

/** Every factId cited anywhere in a tailored CV (QA truth check, UI). */
export function citedFactIds(cv: TailoredCv): string[] {
  const ids = new Set<string>();
  cv.summary?.factIds.forEach((id) => ids.add(id));
  for (const s of cv.sections) for (const i of s.items) for (const b of i.bullets) b.factIds.forEach((id) => ids.add(id));
  return [...ids];
}
