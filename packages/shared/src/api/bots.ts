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
});
export type BotView = z.infer<typeof BotViewSchema>;

export const BotsResponseSchema = z.object({ bots: z.array(BotViewSchema) });

export const BotUpdateRequestSchema = z
  .object({ engine: EngineSchema, enabled: z.boolean(), trustLevel: TrustLevelSchema })
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
