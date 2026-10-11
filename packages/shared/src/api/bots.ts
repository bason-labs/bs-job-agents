// Bots screen (§11 Bots, UC-19) and master CV / saved answers.
import { z } from "zod";
import { EngineSchema, TrustLevelSchema, type BotName, type TrustLevel } from "../common/primitives.js";
import { BotActivitySchema, BotRecordSchema } from "../domain/bot-record.js";
import { EngineStatusSchema } from "../domain/engine-state.js";
import { MasterCvSchema } from "../domain/master-cv.js";
import { SavedAnswerSchema } from "../domain/saved-answer.js";

export const BotViewSchema = BotRecordSchema.extend({
  role: z.string(),
  activity: BotActivitySchema,
  /** e.g. "10 approved in a row without edits" */
  trackRecord: z.string().nullable(),
  /** §5.3: 10 consecutive tasks accepted without changes. */
  promotionSuggested: z.boolean(),
  promoteAllowed: z.boolean(),
  memory: z.array(z.string()),
  /** Codex browser bots: site allowlist is prompt-only (§4.4). */
  residualRisk: z.string().nullable(),
  /** W3a, additive: §5.3 automatic demotion (the latest), null when none; Ba restores with PATCH trustLevel. */
  demotion: z.object({ fromLevel: TrustLevelSchema, at: z.string(), reason: z.string() }).nullable().optional(),
  /** W3a, additive: the memory notes with ids for DELETE /bots/:name/memory/:noteId (PM S14). */
  memoryNotes: z.array(z.object({ id: z.string().min(1), text: z.string() })).optional(),
  /** Additive (live run 1): bot.json's model, used when Ba chose none (`model` is the effective one). */
  defaultModel: z.string().nullable().optional(),
  /** Additive (owner decision 2026-10-11): a Figma bot (CV) on Codex, where its Drafts-only guard hook can't run. */
  figmaGuardOff: z.boolean().optional(),
  /** Additive: when Ba last acknowledged an engine switch's risk (CV to Codex); kept after he switches back. */
  engineRiskAcknowledgedAt: z.string().nullable().optional(),
});
export type BotView = z.infer<typeof BotViewSchema>;

/** W3a, additive: the master CV's saved versions (UC-20 history), newest first. */
export const MasterCvVersionsResponseSchema = z.object({
  versions: z.array(z.object({ version: z.number().int().positive(), savedAt: z.string(), factCount: z.number().int().nonnegative() })),
});

/** W3a, additive: a fact CV asked Ba for while tailoring (CvOutput.factRequests, §6.1) and not yet answered. */
export const FactRequestItemSchema = z.object({
  /** `<cvVersionId>-<index>` */
  id: z.string().min(1),
  jobId: z.string(),
  company: z.string(),
  topic: z.string(),
  question: z.string(),
  reason: z.string(),
});
export type FactRequestItem = z.infer<typeof FactRequestItemSchema>;
export const FactRequestsResponseSchema = z.object({ requests: z.array(FactRequestItemSchema) });

export const BotsResponseSchema = z.object({ bots: z.array(BotViewSchema) });

/**
 * Live run 1: a model name as the CLIs take it (`sonnet`, `claude-opus-4-1`, `opus[1m]`, `gpt-5-codex`,
 * `o3`): never starts with `-`, no spaces. The orchestrator also checks it suits the bot's engine.
 */
export const BotModelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/, "a model name such as sonnet, opus or gpt-5-codex");

export const BotUpdateRequestSchema = z
  .object({
    engine: EngineSchema,
    enabled: z.boolean(),
    trustLevel: TrustLevelSchema,
    /** Additive (live run 1): Ba's model for this bot; null = bot.json's model. */
    model: BotModelNameSchema.nullable(),
    /**
     * Additive (owner decision 2026-10-11): Ba confirms the risk of an engine switch that is safe
     * only with his opt-in (CV to Codex: the Figma guard hook can't run there; FIGMA_UNGUARDED_RISK).
     * Without it that switch is refused with 409; it never unlocks Apply or Lead (403).
     */
    acknowledgeRisk: z.boolean(),
  })
  .partial()
  .strict();
export type BotUpdateRequest = z.infer<typeof BotUpdateRequestSchema>;

export const EnginesResponseSchema = z.object({ engines: z.array(EngineStatusSchema) });

export type CanPromoteResult = { allowed: boolean; reason: string | null };

/** UC-19: only Ba promotes; Apply's promote button stays disabled in Phase 1. */
export function canPromote(botName: BotName, current: TrustLevel): CanPromoteResult {
  if (current >= 2) return { allowed: false, reason: "Already at the highest level" };
  if (botName === "apply") return { allowed: false, reason: "Promoting Apply to L2 is disabled in Phase 1" };
  return { allowed: true, reason: null };
}

export const MasterCvUpdateRequestSchema = MasterCvSchema;
export const SavedAnswersResponseSchema = z.object({ answers: z.array(SavedAnswerSchema) });
