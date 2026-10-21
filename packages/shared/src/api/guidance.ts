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
export type GuidancePositionApplies = z.infer<typeof GuidancePositionAppliesSchema>;

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

/** CV guidance (REQ-36): a rule the refresh added or changed. */
export const GuidanceActivityEntrySchema = z.object({
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
export type GuidanceActivityEntry = z.infer<typeof GuidanceActivityEntrySchema>;

/**
 * Skill self-repair (REQ-11, §7): one entry per attempt (repairing, adopted, not adopted), per
 * restore and per pause. previousText / newText are the skill before and after (null while
 * repairing; for not adopted, newText is the draft that was tried, or null when there was none).
 */
export const SkillRepairActivityEntrySchema = z.object({
  id: IdSchema,
  at: IsoDateTimeSchema,
  kind: z.enum(["skill_repairing", "skill_adopted", "skill_not_adopted", "skill_restored", "skill_repair_paused"]),
  repairId: IdSchema.nullable(),
  source: z.string().min(1),
  sourceLabel: z.string().min(1),
  /** "adapter broken: …", the failure that started the attempt. */
  trigger: z.string().nullable(),
  /** Repairing only: what runs now. */
  status: z.enum(["queued", "drafting", "validating"]).nullable(),
  /** Not adopted: why (a screen rule, the validation result or a write error). */
  reason: z.string().nullable(),
  /** The one file an adopted or restored repair changed (repo-relative). */
  path: z.string().nullable(),
  previousText: z.string().nullable(),
  newText: z.string().nullable(),
  notApplied: z.array(z.object({ file: z.string(), change: z.string() })),
  /** Only on the latest adopted entry of its source while the file still holds its text (§5.7). */
  canRestore: z.boolean(),
  /** Only on the paused entry of a source that is still paused. */
  canRetry: z.boolean(),
});
export type SkillRepairActivityEntry = z.infer<typeof SkillRepairActivityEntrySchema>;

/** Skill self-repair §5.8: a board's API changed (the run used the browser) or works again. No diff. */
export const SourceApiActivityEntrySchema = z.object({
  id: IdSchema,
  at: IsoDateTimeSchema,
  kind: z.enum(["api_changed", "api_recovered"]),
  source: z.string().min(1),
  sourceLabel: z.string().min(1),
  method: z.literal("GET").nullable(),
  host: z.string().nullable(),
  path: z.string().nullable(),
  reason: z.string().nullable(),
});
export type SourceApiActivityEntry = z.infer<typeof SourceApiActivityEntrySchema>;

export const ActivityEntrySchema = z.union([GuidanceActivityEntrySchema, SkillRepairActivityEntrySchema, SourceApiActivityEntrySchema]);
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
  /** Why an earlier round was handed to Ba (a later round failed), or null. */
  note: z.string().nullable().optional(),
});
export type ReviewGuidance = z.infer<typeof ReviewGuidanceSchema>;
