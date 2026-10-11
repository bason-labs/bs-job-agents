// Bot rows, prompt versions and memory changes (§9 `bots`, `prompt_versions`, `memory_changes`).
import { z } from "zod";
import {
  BotNameSchema,
  EngineSchema,
  IdSchema,
  IsoDateTimeSchema,
  TrustLevelSchema,
  type TrustLevel,
} from "../common/primitives.js";

export const BotRecordSchema = z.object({
  name: BotNameSchema,
  displayName: z.string().min(1),
  engine: EngineSchema,
  model: z.string().nullable(),
  trustLevel: TrustLevelSchema,
  promptVersion: z.number().int().positive(),
  enabled: z.boolean(),
});
export type BotRecord = z.infer<typeof BotRecordSchema>;

export const PromptVersionSchema = z.object({
  id: IdSchema,
  botName: BotNameSchema,
  version: z.number().int().positive(),
  roleMdHash: z.string().min(1),
  roleMdText: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type PromptVersion = z.infer<typeof PromptVersionSchema>;

export const MemoryChangeSchema = z.object({
  id: IdSchema,
  botName: BotNameSchema,
  runId: IdSchema.nullable(),
  taskId: IdSchema.nullable(),
  note: z.string().min(1),
  createdAt: IsoDateTimeSchema,
});
export type MemoryChange = z.infer<typeof MemoryChangeSchema>;

/**
 * Highest trust level a bot may hold in Phase 1 (UC-19, PM S1): Apply stays at L1, so every
 * submit needs Ba's approval token. Matches `checkBotSafety` for bot.json; the data layer
 * refuses the same for the `bots` table, and the trust guard requires a token for
 * apply.submit whatever the level says.
 */
export const PHASE1_MAX_TRUST_LEVEL: Readonly<Record<string, TrustLevel>> = { apply: 1 };

export function maxTrustLevel(botName: string): TrustLevel {
  return Object.hasOwn(PHASE1_MAX_TRUST_LEVEL, botName) ? PHASE1_MAX_TRUST_LEVEL[botName]! : 2;
}

export function isTrustLevelAllowed(botName: string, level: TrustLevel): boolean {
  return level <= maxTrustLevel(botName);
}

/**
 * PM2 S8 (§5.3): why a bot was demoted automatically. A safety violation by its own conduct (the
 * SafetyDenialReason of the event: a guard block it did not turn into a pause, a protected-page
 * change, a page mismatch, a dry run that submitted, a tool outside its permissions), or, for CV,
 * a version that left the QA gate with hard fails.
 */
export const DEMOTION_REASON_LABELS: Readonly<Record<string, string>> = {
  off_allowlist: "a site the bot may not open",
  protected_page_blocked: "a change to a protected Figma page (blocked)",
  protected_page_changed: "a protected Figma page changed during its task",
  page_mismatch: "the page showed another company or job than approved",
  dry_run_submitted: "a dry run reported submitted",
  trust_level: "a tool outside its permissions",
  qa_hard_fail: "a CV left the QA gate with hard fails",
};

export function demotionReasonLabel(reason: string): string {
  return DEMOTION_REASON_LABELS[reason] ?? reason;
}

/** One automatic demotion (one level down, never below L0). Ba restores on the Bots screen. */
export const BotDemotionSchema = z.object({
  id: IdSchema,
  botName: BotNameSchema,
  fromLevel: TrustLevelSchema,
  toLevel: TrustLevelSchema,
  /** A SafetyDenialReason or "qa_hard_fail" (DEMOTION_REASON_LABELS has the words). */
  reason: z.string().min(1),
  detail: z.string().nullable(),
  taskId: IdSchema.nullable(),
  runId: IdSchema.nullable(),
  at: IsoDateTimeSchema,
  restoredAt: IsoDateTimeSchema.nullable(),
});
export type BotDemotion = z.infer<typeof BotDemotionSchema>;

/** Bots screen live status dot (§11 Sidebar). */
export const BotActivitySchema = z.enum(["idle", "working", "paused", "waiting_limit", "error"]);
export type BotActivity = z.infer<typeof BotActivitySchema>;
