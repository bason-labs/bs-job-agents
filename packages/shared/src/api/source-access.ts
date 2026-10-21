// API research (design 2026-10-19 §5.1, §5.6): how each source is read, for the Search criteria
// screen's labels and Approve action. Never carries a credential value, only whether one is set.
import { z } from "zod";
import { IsoDateTimeSchema, SearchSourceSchema } from "../common/primitives.js";
import { AccessLabelKeySchema, AccessPathSchema, RiskLevelSchema } from "../source-access/schema.js";

export const SourceAccessViewSchema = z.object({
  source: SearchSourceSchema,
  path: AccessPathSchema,
  /** "Public API" | "Direct (no login)" | "Account API" | "Account API (needs approval)" | "Direct read (needs approval)" | "Account API (token missing)" | "Browser" (ACCESS_LABELS, ACCESS_LABEL_HINTS). */
  labelKey: AccessLabelKeySchema,
  needsApproval: z.boolean(),
  tokenMissing: z.boolean(),
  /** The board's record reads it without logging in (auth "none"): no token or cookie is ever sent. */
  noLogin: z.boolean(),
  /** Ba's approval of this record's research; null when none (or it lapsed with a new researchedAt). */
  approvedAt: IsoDateTimeSchema.nullable(),
  /** The record's research, for the approve dialog; null for the feed boards (no record). */
  researchedAt: z.string().nullable(),
  riskLevel: RiskLevelSchema.nullable(),
  termsOfUse: z.object({ url: z.string(), clauses: z.array(z.string()) }).nullable(),
  accountRisk: z.string().nullable(),
});
export type SourceAccessView = z.infer<typeof SourceAccessViewSchema>;

export const SourceAccessResponseSchema = z.object({ sources: z.array(SourceAccessViewSchema) });
export type SourceAccessResponse = z.infer<typeof SourceAccessResponseSchema>;

/** POST /sources/:source/approval: the researchedAt Ba read; a stale one is refused (409). */
export const SourceApprovalRequestSchema = z.object({ researchedAt: z.string().min(1) });
export type SourceApprovalRequest = z.infer<typeof SourceApprovalRequestSchema>;
