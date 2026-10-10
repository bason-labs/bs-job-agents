// Task keys `<bot>.<kind>` (BOT_TASK_INPUT_SCHEMAS keys) and the rules that hang off them:
// which tasks are outward-facing (§5.3), which are never retried (PM FYI c, UC-11 c, UC-18),
// and which kinds a Phase 1 bot runs (§5.2; PM S4). One source for the workflow schema,
// the engine, its trust guard and crash recovery (PM S2).
import { BOT_TASK_KINDS } from "../bots/definition.js";

export function taskKey(botName: string, kind: string): string {
  return `${botName}.${kind}`;
}

export function splitTaskKey(key: string): { botName: string; kind: string } | null {
  const dot = key.indexOf(".");
  if (dot <= 0 || dot === key.length - 1) return null;
  return { botName: key.slice(0, dot), kind: key.slice(dot + 1) };
}

/**
 * §5.3: an outward-facing action is submitting a form, sending a message or email, accepting a
 * consent, or changing anything outside `data/` and the Figma Drafts page. Such a task runs only
 * in an `action` step (PM S4) and only with a valid approval token (§10.2 rule 1).
 */
export const OUTWARD_FACING_TASK_KEYS = ["apply.submit"] as const;

export function isOutwardFacingTask(botName: string, kind: string): boolean {
  return (OUTWARD_FACING_TASK_KEYS as readonly string[]).includes(taskKey(botName, kind));
}

/**
 * Tasks that are never retried or restarted automatically once started: a failed or interrupted
 * attempt goes to `needs_check`, because it may already have submitted (PM FYI c, UC-11 c, UC-18).
 */
export const NON_RETRYABLE_TASK_KEYS: readonly string[] = OUTWARD_FACING_TASK_KEYS;

/** NON_RETRYABLE_TASK_KEYS as `{ botName, kind }` pairs (crash recovery's filter). */
export const NON_RETRYABLE_TASKS: readonly { botName: string; kind: string }[] = NON_RETRYABLE_TASK_KEYS.map(
  (key) => splitTaskKey(key)!,
);

export function isRetryableTask(botName: string, kind: string): boolean {
  return !NON_RETRYABLE_TASK_KEYS.includes(taskKey(botName, kind));
}

/** True/false for a Phase 1 bot's kinds (BOT_TASK_KINDS); null for a bot added later (not checked). */
export function isKnownTaskKind(botName: string, kind: string): boolean | null {
  if (!Object.hasOwn(BOT_TASK_KINDS, botName)) return null;
  return (BOT_TASK_KINDS as Record<string, readonly string[]>)[botName]!.includes(kind);
}
