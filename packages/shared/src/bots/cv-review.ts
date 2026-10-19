// cv.review (CV guidance §5.7, AD-13): a tool-less check of one tailored CV against the applied
// judgement guidance rules and the JD. One item per rule. It never writes the CV: a fixable miss
// becomes a fix for the next round (only with facts the CV may use), a missing detail a question
// for Ba. QA's contract is untouched; this is a separate task.
import { z } from "zod";
import { botEnvelopeShape } from "./self-check.js";

/** CV's self-check for cv.review (bots/cv/bot.json selfCheckByKind.review). */
export const CV_REVIEW_SELF_CHECK = [
  "One item per rule in the input",
  "Fixes use only the cited facts",
  "A missing detail is a question for Ba, never a guess",
] as const;

export const CvReviewItemSchema = z.strictObject({
  ruleId: z.string().min(1).describe("A ruleId from the input rules"),
  status: z.enum(["met", "not_met", "needs_fact", "not_applicable"]),
  reason: z.string().min(1).max(300).describe("One line: why"),
  fixable: z.boolean().describe("not_met only: a revision can meet the rule with the cited facts alone"),
  fix: z
    .strictObject({
      instruction: z.string().min(1).max(300).describe("What the next round changes, e.g. move the Java role above the React one"),
      factIds: z.array(z.string().min(1)).describe("The fact ids the fix uses (from facts)"),
    })
    .nullable(),
  needsFact: z
    .strictObject({
      factId: z.string().min(1).describe("The one fact the missing detail belongs to"),
      question: z.string().min(1).max(300).describe("The question for Ba, e.g. What result did the order service work have?"),
    })
    .nullable(),
});
export type CvReviewItem = z.infer<typeof CvReviewItemSchema>;

export const CvReviewOutputSchema = z.strictObject({
  items: z.array(CvReviewItemSchema).describe("One item per input rule"),
  ...botEnvelopeShape,
});
export type CvReviewOutput = z.infer<typeof CvReviewOutputSchema>;
