// Self-check result (rule 4, §3) and the envelope every bot output carries.
import { z } from "zod";
import { LIMITS } from "../common/primitives.js";

export const SelfCheckItemSchema = z.object({
  item: z.string().min(1).describe("The checklist item, copied from bot.json selfCheck"),
  passed: z.boolean(),
  note: z.string().nullable().describe("Why it passed or failed; null when nothing to add"),
});
export type SelfCheckItem = z.infer<typeof SelfCheckItemSchema>;

export const SelfCheckSchema = z
  .array(SelfCheckItemSchema)
  .min(1)
  .describe("One entry per selfCheck item in bot.json. Any failed item fails the attempt.");

/** §5.4: up to 3 short lessons, appended to memory.md by the orchestrator. */
export const MemoryNotesSchema = z
  .array(z.string().min(1).max(300))
  .max(LIMITS.memoryNotesMax)
  .describe("Up to 3 short lessons for this bot's memory, e.g. 'TopCV upload limit is 5MB'. Empty if none.");

/** Fields every bot output has. Spread into each output object. */
export const botEnvelopeShape = {
  selfCheck: SelfCheckSchema,
  memoryNotes: MemoryNotesSchema,
};

export function failedSelfChecks(items: readonly SelfCheckItem[]): SelfCheckItem[] {
  return items.filter((i) => !i.passed);
}
