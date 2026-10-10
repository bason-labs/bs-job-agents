// Bot definitions as the engine uses them: bot.json (registry) with the Bots-screen changes from
// the `bots` table (engine switch, trust level, enabled), and which locks a task needs (§10.3).
import { CONVERSATION_TASK_KINDS, taskKey, type BotDefinition, type TrustLevel } from "@bs-job-agents/shared";
import { getBot, type Conn } from "../db/index.js";
import { notFound } from "./errors.js";
import type { BotRegistry } from "./ports.js";

export interface EffectiveBot {
  /** bot.json with the DB's engine; this is what the runner receives. */
  def: BotDefinition;
  /** The DB row's level when present (the trust guard reads it), else bot.json's. */
  trustLevel: TrustLevel;
  enabled: boolean;
}

export function effectiveBot(db: Conn, registry: BotRegistry, name: string): EffectiveBot {
  const def = registry.get(name);
  if (!def) throw notFound("bot", name);
  const row = getBot(db, name);
  return {
    def: { ...def, engine: row?.engine ?? def.engine },
    trustLevel: (row?.trustLevel as TrustLevel | undefined) ?? def.trustLevel,
    enabled: (row?.enabled ?? true) && def.enabled,
  };
}

export const isConversationKind = (kind: string): boolean => (CONVERSATION_TASK_KINDS as readonly string[]).includes(kind);

/** Tasks that drive Ba's Chrome (§10.3 browser lock). Search-only Research tasks don't need it. */
export const BROWSER_TASK_KEYS: readonly string[] = ["research.scan", "research.single", "apply.submit"];
/** Tasks that use the Figma bridge (§6.2 Figma lock). */
export const FIGMA_TASK_KEYS: readonly string[] = ["cv.tailor"];
/** Tasks whose bot reads Ba's master facts: they get a per-task folder with a copy of master-cv.yaml. */
export const MASTER_CV_TASK_KEYS: readonly string[] = ["research.fit", "cv.tailor", "qa.review"];

export function taskNeeds(def: Pick<BotDefinition, "name" | "browser">, kind: string): { usesBrowser: boolean; usesFigma: boolean } {
  if (isConversationKind(kind)) return { usesBrowser: false, usesFigma: false };
  const key = taskKey(def.name, kind);
  return {
    // A bot added later that writes in the browser always takes the lock.
    usesBrowser: BROWSER_TASK_KEYS.includes(key) || def.browser?.mode === "write",
    usesFigma: FIGMA_TASK_KEYS.includes(key),
  };
}
