// Engine state (§9 `engine_state`, UC-16) and the sidebar view of it.
import { z } from "zod";
import { EngineSchema, IsoDateTimeSchema } from "../common/primitives.js";

export const EnginePauseReasonSchema = z.enum(["usage_limit", "manual"]);

export const EngineStateSchema = z.object({
  engine: EngineSchema,
  /** null = running. "Claude paused until 14:05". */
  pausedUntil: IsoDateTimeSchema.nullable(),
  reason: EnginePauseReasonSchema.nullable(),
});
export type EngineState = z.infer<typeof EngineStateSchema>;

/** Utilization from Claude's rate_limit_event (0–1); Codex reports none (spike S1). */
export const EngineUsageSchema = z.object({
  fiveHour: z.number().min(0).max(1).nullable(),
  sevenDay: z.number().min(0).max(1).nullable(),
  resetsAt: IsoDateTimeSchema.nullable(),
});
export type EngineUsage = z.infer<typeof EngineUsageSchema>;

/** Sidebar: usage meter + pause status per engine. */
export const EngineStatusSchema = EngineStateSchema.extend({
  usage: EngineUsageSchema.nullable(),
  activeSessions: z.number().int().nonnegative(),
  maxSessions: z.number().int().positive(),
});
export type EngineStatus = z.infer<typeof EngineStatusSchema>;
