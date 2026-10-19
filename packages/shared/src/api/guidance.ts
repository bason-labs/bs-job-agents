// CV guidance API shapes (§7): the Guidance screen, the Activity screen and the review step's
// guidance panel. All text is plain (SEC-26): the web renders it as text and makes a source URL a
// link only when it is https.
import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "../common/primitives.js";
import { GuidanceReviewResultSchema, GuidanceSourceRefSchema } from "../cv-guidance/review.js";
import { CvConstraintIdSchema, GuidanceAppliesWhenSchema, GuidanceCheckSchema, GuidanceTopicSchema } from "../cv-guidance/schema.js";

export const GuidanceSourceViewSchema = GuidanceSourceRefSchema.extend({
  /** The quote from this source behind the position. */
  evidence: z.string().nullable(),
});
export type GuidanceSourceView = z.infer<typeof GuidanceSourceViewSchema>;

/** How a position fares: for every job, for Vietnam jobs only, for global jobs only, or never. */
export const GuidancePositionAppliesSchema = z.enum(["applied", "applied_vn", "applied_global", "not_applied"]);

export const GuidanceRuleViewSchema = z.object({
  ruleId: z.string().min(1),
  topic: GuidanceTopicSchema,
  point: z.string(),
  check: GuidanceCheckSchema,
  appliesWhen: GuidanceAppliesWhenSchema,
  overriddenBy: z.array(CvConstraintIdSchema),
  /** agree: one position; disputed: more; overridden: a constraint wins; turned_off: Ba's switch. */
  status: z.enum(["agree", "disputed", "overridden", "turned_off"]),
  turnedOff: z.boolean(),
  /** One sentence: why it applies (or not). */
  reason: z.string(),
  positions: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      hosts: z.number().int().nonnegative(),
      applies: GuidancePositionAppliesSchema,
      sources: z.array(GuidanceSourceViewSchema),
    }),
  ),
});
export type GuidanceRuleView = z.infer<typeof GuidanceRuleViewSchema>;

export const GuidanceRefreshSummarySchema = z.object({
  at: IsoDateTimeSchema,
  runId: IdSchema.nullable(),
  outcome: z.enum(["unchanged", "updated", "failed", "used_other_run"]),
  pagesChecked: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  rulesChanged: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type GuidanceRefreshSummary = z.infer<typeof GuidanceRefreshSummarySchema>;

export const GuidanceViewSchema = z.object({
  snapshot: z.number().int().positive().nullable(),
  sourceCount: z.number().int().nonnegative(),
  /** The latest refresh (any outcome), and the latest that read at least one page. */
  lastRefresh: GuidanceRefreshSummarySchema.nullable(),
  lastSuccessAt: IsoDateTimeSchema.nullable(),
  rules: z.array(GuidanceRuleViewSchema),
});
export type GuidanceView = z.infer<typeof GuidanceViewSchema>;

export const ActivityEntrySchema = z.object({
  id: IdSchema,
  at: IsoDateTimeSchema,
  kind: z.enum(["rule_added", "rule_changed"]),
  ruleId: z.string(),
  point: z.string(),
  previousText: z.string(),
  newText: z.string(),
  sources: z.array(GuidanceSourceRefSchema),
  /** False only for a change whose commit failed (SEC-24.AC-3). */
  applied: z.boolean(),
  runId: IdSchema.nullable(),
});
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;
export const ActivityResponseSchema = z.object({ entries: z.array(ActivityEntrySchema) });
export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;

/** The review step's guidance panel for one CV language (§7). */
export const ReviewGuidanceSchema = z.object({
  result: GuidanceReviewResultSchema,
  /** Rounds of this pass that were checked, and how many times the CV was revised for guidance or QA. */
  rounds: z.number().int().positive(),
  revisions: z.number().int().nonnegative(),
  /** The pass used all its rounds (the "Still not met after round 3" note). */
  lastRound: z.boolean(),
});
export type ReviewGuidance = z.infer<typeof ReviewGuidanceSchema>;
