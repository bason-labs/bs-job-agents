// Bot rows, prompt versions and memory changes (§9 `bots`, `prompt_versions`, `memory_changes`).
import { z } from "zod";
import { BotNameSchema, EngineSchema, IdSchema, IsoDateTimeSchema, TrustLevelSchema } from "../common/primitives.js";

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

/** Bots screen live status dot (§11 Sidebar). */
export const BotActivitySchema = z.enum(["idle", "working", "paused", "waiting_limit", "error"]);
export type BotActivity = z.infer<typeof BotActivitySchema>;
