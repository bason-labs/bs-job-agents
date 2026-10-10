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

/** Bots screen live status dot (§11 Sidebar). */
export const BotActivitySchema = z.enum(["idle", "working", "paused", "waiting_limit", "error"]);
export type BotActivity = z.infer<typeof BotActivitySchema>;
