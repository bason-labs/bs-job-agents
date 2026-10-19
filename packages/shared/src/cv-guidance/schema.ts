// CV guidance (sub-project 3, §5.1; AD-10): the rule set is data. Every position of every rule
// cites at least one source, and every source is a page the orchestrator fetched (url) or a file
// in the repo (repoPath). "Disputed" (more than one position) and "pinned" (a position citing an
// attachment) are computed, never stored; "turned off" is Ba's setting, never part of a snapshot.
// Pure: no I/O, no clock (AD-11).
import { z } from "zod";
import { IsoDateTimeSchema } from "../common/primitives.js";
import { QaHardFailCodeSchema } from "../bots/qa.js";

export const GUIDANCE_TOPICS = ["dates", "order", "bullet_content", "contact", "links", "skills", "length", "layout_ats", "summary", "language", "other"] as const;
export const GuidanceTopicSchema = z.enum(GUIDANCE_TOPICS);
export type GuidanceTopic = z.infer<typeof GuidanceTopicSchema>;

/** Deterministic checkers (checks.ts) by id; anything else is a judgement rule for cv.review. */
export const GUIDANCE_CHECKS = ["month_year", "contact_present", "links_present", "practical_experience", "page_length", "judgement"] as const;
export const GuidanceCheckSchema = z.enum(GUIDANCE_CHECKS);
export type GuidanceCheck = z.infer<typeof GuidanceCheckSchema>;

export const GuidanceSourceKindSchema = z.enum(["vn_recruiter", "global_recruiter", "ats_vendor", "hr_publication", "attachment"]);
export type GuidanceSourceKind = z.infer<typeof GuidanceSourceKindSchema>;

export const GuidanceMarketSchema = z.enum(["vn", "global"]);
export type GuidanceMarket = z.infer<typeof GuidanceMarketSchema>;

/** When a rule applies, evaluated by code (resolve.ts). */
export const GuidanceAppliesWhenSchema = z.enum(["always", "has_profile_link"]);
export type GuidanceAppliesWhen = z.infer<typeof GuidanceAppliesWhenSchema>;

/**
 * The CV bot's named layout and ATS rules (bots/cv/ROLE.md "Layout"): a guidance position that
 * contradicts one is overridden by it, as by a QA hard fail (REQ-34, SEC-22).
 */
export const CV_LAYOUT_RULES = {
  cv_one_a4_page: "One A4 page (portrait)",
  cv_ats_real_text: "All content as real text: no text in images or outlines",
  cv_ats_plain_headings: "Plain section headings",
  cv_reading_order: "Text frames in one reading order",
  cv_contact_line: "The contact line is always present",
} as const;
export const CvLayoutRuleIdSchema = z.enum(Object.keys(CV_LAYOUT_RULES) as [keyof typeof CV_LAYOUT_RULES, ...(keyof typeof CV_LAYOUT_RULES)[]]);
export type CvLayoutRuleId = z.infer<typeof CvLayoutRuleIdSchema>;

/** A QA hard-fail code or a CV layout rule: what always wins over guidance. */
export const CvConstraintIdSchema = z.union([QaHardFailCodeSchema, CvLayoutRuleIdSchema]);
export type CvConstraintId = z.infer<typeof CvConstraintIdSchema>;

/** SEC-22 caps. */
export const GUIDANCE_LIMITS = { rules: 100, sources: 40, textChars: 300, titleChars: 200, positionsPerRule: 5 } as const;

const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, "a lowercase slug");
/** Plain text: no control characters (SEC-26.AC-2). */
// eslint-disable-next-line no-control-regex
const PlainText = (max: number) => z.string().min(1).max(max).refine((s) => !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(s), "no control characters");

export const GuidanceSourceSchema = z
  .object({
    id: SlugSchema,
    title: PlainText(GUIDANCE_LIMITS.titleChars).nullable(),
    publisher: PlainText(GUIDANCE_LIMITS.titleChars).nullable(),
    /** https only (SEC-21); taken from the fetch, never from model output (SEC-23). */
    url: z.string().url().refine((u) => u.startsWith("https://"), "https only").nullable(),
    /** A file in the repo (the VNPT post). */
    repoPath: z.string().min(1).nullable(),
    /** Set by code: the refresh time, or the seed's retrieval date. */
    retrievedAt: IsoDateTimeSchema,
    kind: GuidanceSourceKindSchema,
    market: GuidanceMarketSchema,
    /** Registrable domain (or `attachment:<publisher>`), computed by code: sources count once per host (SEC-23). */
    host: z.string().min(1),
    /** Change detection (§5.4): sha256 of the page's content key, and the conditional-GET validators. */
    contentHash: z.string().nullable().default(null),
    etag: z.string().nullable().default(null),
    lastModified: z.string().nullable().default(null),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (!s.title && !s.publisher) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["title"], message: "a source needs a title or a publisher" });
    if (!s.url && !s.repoPath) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "a source needs a url or a repo path" });
  });
export type GuidanceSource = z.infer<typeof GuidanceSourceSchema>;
export type GuidanceSourceInput = z.input<typeof GuidanceSourceSchema>;

export const GuidanceEvidenceSchema = z.object({ sourceId: SlugSchema, quote: PlainText(GUIDANCE_LIMITS.textChars) }).strict();
export type GuidanceEvidence = z.infer<typeof GuidanceEvidenceSchema>;

export const GuidancePositionSchema = z
  .object({
    id: SlugSchema,
    text: PlainText(GUIDANCE_LIMITS.textChars),
    sourceIds: z.array(SlugSchema).min(1),
    /** One short verbatim quote per source, from that source's fetched text (SEC-23). */
    evidence: z.array(GuidanceEvidenceSchema),
  })
  .strict();
export type GuidancePosition = z.infer<typeof GuidancePositionSchema>;

export const GuidanceRuleSchema = z
  .object({
    id: SlugSchema,
    topic: GuidanceTopicSchema,
    /** What the rule is about (e.g. "Dates give month and year"). */
    point: PlainText(GUIDANCE_LIMITS.textChars),
    check: GuidanceCheckSchema,
    appliesWhen: GuidanceAppliesWhenSchema,
    /** Set by code (SEC-22): the constraints that win over this rule. */
    overriddenBy: z.array(CvConstraintIdSchema),
    positions: z.array(GuidancePositionSchema).min(1).max(GUIDANCE_LIMITS.positionsPerRule),
  })
  .strict();
export type GuidanceRule = z.infer<typeof GuidanceRuleSchema>;

export const GuidanceRuleSetSchema = z
  .object({
    sources: z.array(GuidanceSourceSchema).max(GUIDANCE_LIMITS.sources),
    rules: z.array(GuidanceRuleSchema).max(GUIDANCE_LIMITS.rules),
  })
  .strict()
  .superRefine((set, ctx) => {
    const sourceIds = new Set<string>();
    set.sources.forEach((s, i) => {
      if (sourceIds.has(s.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sources", i, "id"], message: `duplicate source id ${s.id}` });
      sourceIds.add(s.id);
    });
    const ruleIds = new Set<string>();
    set.rules.forEach((r, i) => {
      if (ruleIds.has(r.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rules", i, "id"], message: `duplicate rule id ${r.id}` });
      ruleIds.add(r.id);
      const positionIds = new Set<string>();
      r.positions.forEach((p, j) => {
        if (positionIds.has(p.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rules", i, "positions", j, "id"], message: `duplicate position id ${p.id}` });
        positionIds.add(p.id);
        for (const id of p.sourceIds) {
          if (!sourceIds.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rules", i, "positions", j, "sourceIds"], message: `unknown source ${id}` });
        }
        for (const e of p.evidence) {
          if (!p.sourceIds.includes(e.sourceId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rules", i, "positions", j, "evidence"], message: `evidence for ${e.sourceId}, which the position does not cite` });
        }
      });
    });
  });
export type GuidanceRuleSet = z.infer<typeof GuidanceRuleSetSchema>;
export type GuidanceRuleSetInput = z.input<typeof GuidanceRuleSetSchema>;

/** A stored snapshot: its number (one higher than the last), when and by which run it was made. */
export interface GuidanceSnapshot {
  snapshot: number;
  createdAt: string;
  runId: number | null;
  ruleSet: GuidanceRuleSet;
}

// ---------------------------------------------------------------- computed

export const isDisputed = (rule: Pick<GuidanceRule, "positions">): boolean => rule.positions.length > 1;

/** A position citing a repo file (the VNPT post) is pinned: never rewritten or removed (AD-10). */
export function isPinnedPosition(set: Pick<GuidanceRuleSet, "sources">, position: Pick<GuidancePosition, "sourceIds">): boolean {
  return position.sourceIds.some((id) => set.sources.find((s) => s.id === id)?.kind === "attachment");
}

/** Distinct publisher hosts behind a position (SEC-23: several pages of one host count once). */
export function distinctHosts(set: Pick<GuidanceRuleSet, "sources">, position: Pick<GuidancePosition, "sourceIds">): string[] {
  const hosts = new Set<string>();
  for (const id of position.sourceIds) {
    const s = set.sources.find((x) => x.id === id);
    if (s) hosts.add(s.host);
  }
  return [...hosts];
}

/** Hosts of every non-attachment source the rules cite (REQ-31: at least 2; discovery runs below 3). */
export function citedWebHosts(set: GuidanceRuleSet): string[] {
  const cited = new Set(set.rules.flatMap((r) => r.positions.flatMap((p) => p.sourceIds)));
  return [...new Set(set.sources.filter((s) => cited.has(s.id) && s.kind !== "attachment").map((s) => s.host))];
}

/** A rule's statement as one text (activity entries: previous and new text). */
export function ruleText(rule: Pick<GuidanceRule, "positions">): string {
  return rule.positions.map((p) => p.text).join("\n");
}

/** Strip control characters and squash whitespace (SEC-26.AC-2), capped. */
export function plainText(s: string, max: number = GUIDANCE_LIMITS.textChars): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
